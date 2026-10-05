using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using OGKToolBox.Core.Abstractions;
using OGKToolBox.Core.Models;

namespace OGKToolBox.Infrastructure.Configuration;

public sealed class GameConfigurationEditor : IGameConfigurationEditor
{
    public async Task<ConfigurationChangePreview> PreviewAsync(
        GameInstallation installation,
        GameConfigurationFileKind kind,
        IReadOnlyList<ConfigurationEdit> edits,
        string expectedBaselineHash,
        CancellationToken cancellationToken)
    {
        var path = ResolvePath(installation, kind);
        var errors = new List<string>();
        if (kind is GameConfigurationFileKind.ConfigClient or GameConfigurationFileKind.ConfigCommon or GameConfigurationFileKind.ConfigServer)
            errors.Add("JSON 配置目前只读；完成原位置 token 替换前不会整文件重写。");
        if (!File.Exists(path)) errors.Add("目标配置文件不存在。");
        if (edits.Count == 0) errors.Add("没有待预览的更改。");
        if (errors.Count > 0)
            return new(kind, path, expectedBaselineHash, string.Empty, [], errors);

        var bytes = await File.ReadAllBytesAsync(path, cancellationToken);
        var currentHash = Hash(bytes);
        if (!currentHash.Equals(expectedBaselineHash, StringComparison.OrdinalIgnoreCase))
            errors.Add("文件已被其他程序修改，请重新读取后再编辑。");
        var document = RoundTripIniDocument.Parse(bytes);
        var changes = new List<ConfigurationValueChange>();
        var enabledMods = kind == GameConfigurationFileKind.Mu3
            ? GameConfigurationInspector.GetEnabledModNames(installation.RootPath)
            : null;
        foreach (var edit in OrderEdits(edits))
        {
            var requestedKeychipComment = IsKeychipId(kind, edit.Section, edit.Key)
                && string.IsNullOrWhiteSpace(edit.NewValue);
            if (edit.Remove && !IsRemovableOption(kind, edit.Section, edit.Key)
                && !requestedKeychipComment)
            {
                errors.Add($"[{edit.Section}] {edit.Key} 不支持删除。");
                continue;
            }
            if (edit.NewValue.Contains('\r') || edit.NewValue.Contains('\n') || edit.NewValue.Contains('\0'))
            {
                errors.Add($"第 {edit.LineNumber} 行包含不允许的换行或 NUL 字符。");
                continue;
            }
            if (kind == GameConfigurationFileKind.SegaTools
                && edit.Section.Equals("pcbid", StringComparison.OrdinalIgnoreCase))
            {
                errors.Add("[pcbid] 配置不由 OGKToolBox 修改。");
                continue;
            }
            var requestedMods = GameConfigurationInspector.GetRequiredMods(kind, edit.Section, edit.Key);
            var isVanillaCompatibleValue = kind == GameConfigurationFileKind.Mu3
                && ((edit.Section, edit.Key) is ("Sound", "WasapiExclusive") or ("Sequence", "QuickStart"))
                && edit.NewValue is "0" or "1";
            if (requestedMods.Count > 0 && (enabledMods is null || !requestedMods.Any(enabledMods.Contains))
                && !isVanillaCompatibleValue)
            {
                errors.Add($"[{edit.Section}] {edit.Key} 只有在启用对应 Mod（{string.Join("、", requestedMods)}）后才能配置。");
                continue;
            }
            if (edit.LineNumber == 0)
            {
                if (requestedKeychipComment)
                {
                    errors.Add("空 Keychip 会保持为注释状态，请填写值后再添加。");
                    continue;
                }
                if (kind is not (GameConfigurationFileKind.Mu3 or GameConfigurationFileKind.SegaTools)
                    || string.IsNullOrWhiteSpace(edit.Section)
                    || string.IsNullOrWhiteSpace(edit.Key)
                    || !GameConfigurationInspector.IsAddableOption(kind, edit.Section, edit.Key))
                {
                    errors.Add(kind == GameConfigurationFileKind.SegaTools
                        ? "只能新增已收录的 segatools.ini 配置项。"
                        : "只能新增已收录且与已启用 Mod 对应的 mu3.ini 选项。");
                    continue;
                }
                if (document.Lines.Any(line => line.Kind == IniLineKind.KeyValue
                    && line.Section.Equals(edit.Section, StringComparison.OrdinalIgnoreCase)
                    && string.Equals(line.Key, edit.Key, StringComparison.OrdinalIgnoreCase)))
                {
                    errors.Add($"[{edit.Section}] {edit.Key} 已存在，请重新读取配置后再编辑。");
                    continue;
                }
                var addedValueError = ValidateValue(kind, edit.Section, edit.Key,
                    GameConfigurationInspector.GetValueKind(kind, edit.Section, edit.Key), edit.NewValue);
                if (addedValueError is not null)
                {
                    errors.Add($"[{edit.Section}] {edit.Key}：{addedValueError}");
                    continue;
                }
                document = document.WithAddedValue(edit.Section, edit.Key, edit.NewValue);
                changes.Add(new(edit.Section, edit.Key, "未设置", edit.NewValue, 0));
                continue;
            }
            var currentLineNumber = CurrentLineNumber(document, edit.LineNumber);
            var source = document.Lines.ElementAtOrDefault(currentLineNumber - 1);
            if (source is null || source.Kind != IniLineKind.KeyValue || source.Key is null)
            {
                errors.Add($"第 {edit.LineNumber} 行不再是有效配置项。");
                continue;
            }
            if (!string.Equals(source.Value, edit.OriginalValue, StringComparison.Ordinal))
            {
                errors.Add($"[{source.Section}] {source.Key} 的原值已经变化，请重新读取。");
                continue;
            }
            var shouldCommentKeychip = IsKeychipId(kind, source.Section, source.Key)
                && string.IsNullOrWhiteSpace(edit.NewValue);
            if (edit.Remove || shouldCommentKeychip)
            {
                document = document.WithCommentedOutValue(currentLineNumber);
                changes.Add(new(source.Section, source.Key, edit.OriginalValue, "已注释", edit.LineNumber));
                continue;
            }
            var valueError = ValidateValue(kind, source.Section, source.Key,
                GameConfigurationInspector.GetValueKind(kind, source.Section, source.Key), edit.NewValue);
            if (valueError is not null)
            {
                errors.Add($"[{source.Section}] {source.Key}：{valueError}");
                continue;
            }
            if (string.Equals(edit.OriginalValue, edit.NewValue, StringComparison.Ordinal)) continue;
            document = document.WithValue(currentLineNumber, edit.NewValue);
            changes.Add(new(source.Section, source.Key, edit.OriginalValue, edit.NewValue, edit.LineNumber));
        }
        if (changes.Count == 0 && errors.Count == 0) errors.Add("新值与当前值相同。");
        return new(kind, path, currentHash, Hash(document.ToBytes()), changes, errors);
    }

    public async Task<ConfigurationSaveResult> SaveAsync(
        GameInstallation installation,
        ConfigurationChangePreview confirmedPreview,
        IReadOnlyList<ConfigurationEdit> edits,
        string backupRoot,
        CancellationToken cancellationToken)
    {
        if (!confirmedPreview.CanSave) throw new InvalidOperationException("该预览没有通过校验，不能保存。");
        ThrowIfGameIsRunning();
        var freshPreview = await PreviewAsync(installation, confirmedPreview.Kind, edits,
            confirmedPreview.BaselineHash, cancellationToken);
        if (!freshPreview.CanSave || !freshPreview.ProposedHash.Equals(confirmedPreview.ProposedHash, StringComparison.Ordinal))
            throw new IOException("配置内容或编辑草稿已变化，请重新生成差异预览。");

        var path = ResolvePath(installation, confirmedPreview.Kind);
        var originalBytes = await File.ReadAllBytesAsync(path, cancellationToken);
        var document = RoundTripIniDocument.Parse(originalBytes);
        foreach (var edit in OrderEdits(edits))
        {
            var currentLineNumber = edit.LineNumber == 0 ? 0 : CurrentLineNumber(document, edit.LineNumber);
            document = edit.Remove || IsKeychipId(edit.Section, edit.Key) && string.IsNullOrWhiteSpace(edit.NewValue)
                ? document.WithCommentedOutValue(currentLineNumber)
                : edit.LineNumber == 0
                ? document.WithAddedValue(edit.Section, edit.Key, edit.NewValue)
                : document.WithValue(currentLineNumber, edit.NewValue);
        }
        var proposedBytes = document.ToBytes();

        var installationId = Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(
            Path.GetFullPath(installation.RootPath).ToUpperInvariant())))[..16];
        var backupDirectory = Path.Combine(backupRoot, installationId, Path.GetFileName(path));
        Directory.CreateDirectory(backupDirectory);
        var stamp = DateTimeOffset.Now.ToString("yyyyMMdd-HHmmss-fff");
        var backupPath = Path.Combine(backupDirectory, $"{stamp}.bak");
        await File.WriteAllBytesAsync(backupPath, originalBytes, cancellationToken);

        var temporaryPath = path + $".ogktoolbox-{Guid.NewGuid():N}.tmp";
        try
        {
            await using (var stream = new FileStream(temporaryPath, FileMode.CreateNew, FileAccess.Write,
                             FileShare.None, 4096, FileOptions.Asynchronous | FileOptions.WriteThrough))
            {
                await stream.WriteAsync(proposedBytes, cancellationToken);
                await stream.FlushAsync(cancellationToken);
            }
            File.Move(temporaryPath, path, true);
        }
        finally
        {
            if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
        }

        var savedAt = DateTimeOffset.Now;
        var result = new ConfigurationSaveResult(path, backupPath, Hash(proposedBytes), savedAt);
        try { await AppendOperationAsync(backupRoot, installationId, result, freshPreview.Changes, cancellationToken); }
        catch (IOException) { /* The configuration and backup are already durable; logging is best effort. */ }
        return result;
    }

    // Additions reparse and renumber the document, so apply edits to original lines first.
    private static IEnumerable<ConfigurationEdit> OrderEdits(IReadOnlyList<ConfigurationEdit> edits) =>
        edits.OrderBy(edit => edit.LineNumber == 0);

    private static int CurrentLineNumber(RoundTripIniDocument document, int originalLineNumber)
    {
        // Commenting out AimeDB can remove old placeholders. Remaining lines retain
        // their original IDs even when their physical positions have moved.
        for (var index = 0; index < document.Lines.Count; index++)
            if (document.Lines[index].LineNumber == originalLineNumber) return index + 1;
        return 0;
    }

    private static string ResolvePath(GameInstallation installation, GameConfigurationFileKind kind) => kind switch
    {
        GameConfigurationFileKind.SegaTools => Path.Combine(installation.RootPath, "segatools.ini"),
        GameConfigurationFileKind.Mu3 => Path.Combine(installation.RootPath, "mu3.ini"),
        GameConfigurationFileKind.BepInEx => Path.Combine(installation.RootPath, "BepInEx", "config", "BepInEx.cfg"),
        GameConfigurationFileKind.ConfigClient => Path.Combine(installation.RootPath, "config_client.json"),
        GameConfigurationFileKind.ConfigCommon => Path.Combine(installation.RootPath, "config_common.json"),
        GameConfigurationFileKind.ConfigServer => Path.Combine(installation.RootPath, "config_server.json"),
        _ => throw new ArgumentOutOfRangeException(nameof(kind))
    };

    private static void ThrowIfGameIsRunning()
    {
        foreach (var processName in new[] { "mu3", "amdaemon", "inject" })
        {
            if (Process.GetProcessesByName(processName).Length > 0)
                throw new InvalidOperationException($"检测到 {processName}.exe 正在运行。请先完全关闭游戏环境再保存配置。");
        }
    }

    private static async Task AppendOperationAsync(
        string backupRoot,
        string installationId,
        ConfigurationSaveResult result,
        IReadOnlyList<ConfigurationValueChange> changes,
        CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(Path.Combine(backupRoot, installationId));
        var record = JsonSerializer.Serialize(new
        {
            savedAt = result.SavedAt,
            result.Path,
            result.BackupPath,
            result.ContentHash,
            changes
        });
        await File.AppendAllTextAsync(Path.Combine(backupRoot, installationId, "operations.jsonl"),
            record + Environment.NewLine, cancellationToken);
    }

    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes));

    private static bool IsRemovableOption(GameConfigurationFileKind kind, string section, string key) =>
        kind == GameConfigurationFileKind.SegaTools
        && section.Equals("dns", StringComparison.OrdinalIgnoreCase)
        && key.Equals("aimedb", StringComparison.OrdinalIgnoreCase);

    private static bool IsKeychipId(GameConfigurationFileKind kind, string section, string key) =>
        kind == GameConfigurationFileKind.SegaTools
        && section.Equals("keychip", StringComparison.OrdinalIgnoreCase)
        && key.Equals("id", StringComparison.OrdinalIgnoreCase);

    private static bool IsKeychipId(string section, string key) =>
        section.Equals("keychip", StringComparison.OrdinalIgnoreCase)
        && key.Equals("id", StringComparison.OrdinalIgnoreCase);

    private static string? ValidateValue(GameConfigurationFileKind file, string section, string key,
        ConfigurationValueKind kind, string value)
    {
        var genericError = ValidateValue(kind, value);
        if (genericError is not null) return genericError;
        if (file != GameConfigurationFileKind.Mu3) return null;
        if (kind == ConfigurationValueKind.Boolean && value is not ("0" or "1"))
            return "需要布尔值（只能填写 0 或 1）。";
        if (!long.TryParse(value, System.Globalization.NumberStyles.Integer,
                System.Globalization.CultureInfo.InvariantCulture, out var integer)) return null;
        return (section, key) switch
        {
            ("Extra", "BGM") when integer is < -1 or > 6 => "BGM 只能填写 -1 到 6。",
            ("Extra", "GP") when integer is < 0 or > 999 => "GP 只能填写 0 到 999。",
            ("Sound", "WasapiExclusive") when integer is < 0 or > 2 => "WasapiExclusive 只能填写 0、1 或 2。",
            ("Sound", "SampleRate") when integer <= 0 => "SampleRate 必须是正整数。",
            ("Video", "Framerate") when integer < -1 => "Framerate 只能填写 -1、0 或正整数。",
            _ => null
        };
    }

    private static string? ValidateValue(ConfigurationValueKind kind, string value) => kind switch
    {
        ConfigurationValueKind.Boolean when value is not ("0" or "1")
            && !bool.TryParse(value, out _) => "需要布尔值（0、1、true 或 false）。",
        ConfigurationValueKind.Integer when !long.TryParse(value,
            System.Globalization.NumberStyles.Integer,
            System.Globalization.CultureInfo.InvariantCulture, out _) => "需要整数。",
        _ => null
    };
}
