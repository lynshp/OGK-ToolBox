using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using OGKToolBox.Core.Abstractions;
using OGKToolBox.Core.Models;

namespace OGKToolBox.Infrastructure.Configuration;

public sealed class GameConfigurationInspector : IGameConfigurationInspector
{
    private const string SchemaVersion = "SDDT 1.50";
    private static readonly IReadOnlyDictionary<string, FieldDefinition> Schema = BuildSchema();
    private static readonly HashSet<string> VanillaAndModdedKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        Key(GameConfigurationFileKind.Mu3, "Sound", "WasapiExclusive"),
        Key(GameConfigurationFileKind.Mu3, "Sequence", "QuickStart")
    };

    public async Task<GameConfigurationSnapshot> InspectAsync(
        GameInstallation installation,
        CancellationToken cancellationToken)
    {
        var root = installation.RootPath;
        var files = new List<ConfigurationFileSnapshot>
        {
            await ReadConfigurationAsync(GameConfigurationFileKind.SegaTools, "segatools.ini",
                Path.Combine(root, "segatools.ini"), cancellationToken),
            await ReadConfigurationAsync(GameConfigurationFileKind.Mu3, "mu3.ini",
                Path.Combine(root, "mu3.ini"), cancellationToken),
            await ReadConfigurationAsync(GameConfigurationFileKind.BepInEx, "BepInEx.cfg",
                Path.Combine(root, "BepInEx", "config", "BepInEx.cfg"), cancellationToken),
            await ReadJsonConfigurationAsync(GameConfigurationFileKind.ConfigClient, "config_client.json",
                Path.Combine(root, "config_client.json"), cancellationToken),
            await ReadJsonConfigurationAsync(GameConfigurationFileKind.ConfigCommon, "config_common.json",
                Path.Combine(root, "config_common.json"), cancellationToken),
            await ReadJsonConfigurationAsync(GameConfigurationFileKind.ConfigServer, "config_server.json",
                Path.Combine(root, "config_server.json"), cancellationToken)
        };

        var diagnostics = new List<LibraryDiagnostic>();
        var segaToolsIndex = files.FindIndex(file => file.Kind == GameConfigurationFileKind.SegaTools);
        if (!files[segaToolsIndex].Exists)
            diagnostics.Add(new(DiagnosticSeverity.Warning, "SEGATOOLS_CONFIG_MISSING",
                "未找到 segatools.ini；无法读取街机环境与 IO 配置。", files[segaToolsIndex].Path));
        else
        {
            files[segaToolsIndex] = files[segaToolsIndex] with
            {
                Entries = AddMissingEditableSegaToolsOptions(files[segaToolsIndex].Entries)
            };
            AddMissingRequiredVfsDiagnostics(files[segaToolsIndex], diagnostics);
        }
        if (!files[1].Exists)
            diagnostics.Add(new(DiagnosticSeverity.Information, "MU3_CONFIG_MISSING",
                "未找到 mu3.ini；游戏可能正在使用默认配置。", files[1].Path));

        var bepinExPath = Path.Combine(root, "BepInEx");
        if (!Directory.Exists(bepinExPath))
            diagnostics.Add(new(DiagnosticSeverity.Information, "BEPINEX_NOT_INSTALLED",
                "未检测到 BepInEx，Mod 页面将保持空白。", bepinExPath));

        var mods = Directory.Exists(bepinExPath)
            ? await Task.Run(() => DiscoverMods(bepinExPath, cancellationToken), cancellationToken)
            : [];
        var mu3FileIndex = files.FindIndex(file => file.Kind == GameConfigurationFileKind.Mu3);
        if (mu3FileIndex >= 0)
            files[mu3FileIndex] = files[mu3FileIndex] with
            {
                Entries = AddMissingEditableMu3Options(files[mu3FileIndex].Entries, mods)
            };
        var hookVersion = ReadFileVersion(Path.Combine(root, "mu3hook.dll"));
        return new GameConfigurationSnapshot(root, hookVersion, files, mods, diagnostics);
    }

    private static async Task<ConfigurationFileSnapshot> ReadConfigurationAsync(
        GameConfigurationFileKind kind,
        string displayName,
        string path,
        CancellationToken cancellationToken)
    {
        if (!File.Exists(path))
            return new(kind, displayName, path, false, "—", "—", null, 0, []);

        var bytes = await File.ReadAllBytesAsync(path, cancellationToken);
        var document = RoundTripIniDocument.Parse(bytes);
        var entries = document.Lines
            .Where(line => line.Kind == IniLineKind.KeyValue && line.Key is not null)
            .Select(line => CreateEntry(kind, line))
            .ToList();
        var info = new FileInfo(path);
        return new(kind, displayName, path, true, document.EncodingName, document.NewLineName,
            info.LastWriteTimeUtc, info.Length, entries, Hash(bytes));
    }

    private static async Task<ConfigurationFileSnapshot> ReadJsonConfigurationAsync(
        GameConfigurationFileKind kind,
        string displayName,
        string path,
        CancellationToken cancellationToken)
    {
        if (!File.Exists(path))
            return new(kind, displayName, path, false, "—", "—", null, 0, []);
        var bytes = await File.ReadAllBytesAsync(path, cancellationToken);
        using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions
        {
            AllowTrailingCommas = true,
            CommentHandling = JsonCommentHandling.Skip
        });
        var entries = new List<ConfigurationEntry>();
        FlattenJson(document.RootElement, string.Empty, entries);
        var info = new FileInfo(path);
        var newLine = bytes.AsSpan().IndexOf("\r\n"u8) >= 0 ? "CRLF" : "LF";
        return new(kind, displayName, path, true, "utf-8", newLine,
            info.LastWriteTimeUtc, info.Length, entries, Hash(bytes));
    }

    private static void FlattenJson(JsonElement element, string path, ICollection<ConfigurationEntry> target)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in element.EnumerateObject())
            {
                var childPath = path + "/" + EscapePointer(property.Name);
                if (property.Value.ValueKind is JsonValueKind.Object)
                    FlattenJson(property.Value, childPath, target);
                else
                    AddJsonEntry(property.Name, childPath, property.Value, target);
            }
        }
    }

    private static void AddJsonEntry(string key, string locator, JsonElement value, ICollection<ConfigurationEntry> target)
    {
        var sectionEnd = locator.LastIndexOf('/');
        var section = locator[..sectionEnd].TrimStart('/').Replace('/', '.');
        var kind = value.ValueKind switch
        {
            JsonValueKind.True or JsonValueKind.False => ConfigurationValueKind.Boolean,
            JsonValueKind.Number => ConfigurationValueKind.Integer,
            _ => ConfigurationValueKind.Text
        };
        var display = value.ValueKind == JsonValueKind.String ? value.GetString() ?? string.Empty : value.GetRawText();
        target.Add(new(section, key, display, display, kind, 0,
            $"AM daemon JSON 配置 · Schema {SchemaVersion}", false, true, locator));
    }

    private static ConfigurationEntry CreateEntry(GameConfigurationFileKind kind, IniLine line)
    {
        var schemaKey = Key(kind, line.Section, line.Key!);
        var known = Schema.TryGetValue(schemaKey, out var definition);
        definition ??= new(ConfigurationValueKind.Text, "此配置项未收录在当前 Schema 中。", false);
        var value = line.Value ?? string.Empty;
        var displayValue = definition.IsSensitive && value.Length > 0 ? Mask(value) : value;
        return new(line.Section, line.Key!, value, displayValue, definition.Kind, line.LineNumber,
            definition.Description, definition.IsSensitive, known, "", true, definition.DefaultValue,
            definition.RequiredMods);
    }

    internal static ConfigurationValueKind GetValueKind(
        GameConfigurationFileKind kind,
        string section,
        string key) => Schema.TryGetValue(Key(kind, section, key), out var definition)
        ? definition.Kind
        : ConfigurationValueKind.Text;

    public static IReadOnlyList<string> GetRequiredMods(
        GameConfigurationFileKind kind,
        string section,
        string key) => Schema.TryGetValue(Key(kind, section, key), out var definition)
        ? definition.RequiredMods ?? []
        : [];

    public static IReadOnlySet<string> GetEnabledModNames(string root)
    {
        var bepinExPath = Path.Combine(root, "BepInEx");
        return !Directory.Exists(bepinExPath)
            ? new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            : DiscoverMods(bepinExPath, CancellationToken.None).Where(mod => mod.IsEnabled)
                .Select(mod => mod.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
    }

    internal static bool IsAddableOption(GameConfigurationFileKind kind, string section, string key) =>
        Schema.TryGetValue(Key(kind, section, key), out var definition) && definition.IsAddable;

    private static IReadOnlyList<ConfigurationEntry> AddMissingEditableMu3Options(
        IReadOnlyList<ConfigurationEntry> source,
        IReadOnlyList<InstalledMod> mods)
    {
        var entries = source.ToList();
        var kind = GameConfigurationFileKind.Mu3;
        var enabledMods = new HashSet<string>(mods.Where(mod => mod.IsEnabled).Select(mod => mod.Name),
            StringComparer.OrdinalIgnoreCase);
        var present = new HashSet<string>(entries.Select(entry => Key(kind, entry.Section, entry.Key)),
            StringComparer.OrdinalIgnoreCase);
        foreach (var (schemaKey, definition) in Schema.Where(pair => pair.Key.StartsWith($"{kind}:", StringComparison.Ordinal)
                     && pair.Value.IsAddable
                     && (pair.Value.RequiredMods is null || pair.Value.RequiredMods.Any(enabledMods.Contains)
                         || VanillaAndModdedKeys.Contains(pair.Key)))
                     .OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase))
        {
            if (present.Contains(schemaKey)) continue;
            var parts = schemaKey.Split(':', 3);
            var useVanillaDefault = definition.RequiredMods is not null
                && !definition.RequiredMods.Any(enabledMods.Contains)
                && VanillaAndModdedKeys.Contains(schemaKey);
            var defaultValue = useVanillaDefault ? "0" : definition.DefaultValue;
            entries.Add(new(parts[1], parts[2], string.Empty, $"未设置（默认 {defaultValue}）",
                definition.Kind, 0, definition.Description, definition.IsSensitive, true,
                $"{parts[1]}:{parts[2]}", false, defaultValue, definition.RequiredMods));
        }
        return entries;
    }

    private static IReadOnlyList<ConfigurationEntry> AddMissingEditableSegaToolsOptions(
        IReadOnlyList<ConfigurationEntry> source)
    {
        var entries = source.ToList();
        var kind = GameConfigurationFileKind.SegaTools;
        var present = new HashSet<string>(entries.Select(entry => Key(kind, entry.Section, entry.Key)),
            StringComparer.OrdinalIgnoreCase);
        foreach (var (schemaKey, definition) in Schema.Where(pair => pair.Key.StartsWith($"{kind}:", StringComparison.Ordinal)
                     && pair.Value.IsAddable)
                     .OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase))
        {
            if (present.Contains(schemaKey)) continue;
            var parts = schemaKey.Split(':', 3);
            var displayValue = parts[1].Equals("dns", StringComparison.OrdinalIgnoreCase)
                && parts[2].Equals("aimedb", StringComparison.OrdinalIgnoreCase)
                ? "未设置（不填默认不开启）"
                : $"未设置（默认 {definition.DefaultValue}）";
            entries.Add(new(parts[1], parts[2], string.Empty, displayValue,
                definition.Kind, 0, definition.Description, definition.IsSensitive, true,
                $"{parts[1]}:{parts[2]}", false, definition.DefaultValue));
        }
        return entries;
    }

    private static void AddMissingRequiredVfsDiagnostics(
        ConfigurationFileSnapshot file,
        ICollection<LibraryDiagnostic> diagnostics)
    {
        foreach (var key in new[] { "amfs", "option", "appdata" })
        {
            var entry = file.Entries.FirstOrDefault(item => item.Section.Equals("vfs", StringComparison.OrdinalIgnoreCase)
                && item.Key.Equals(key, StringComparison.OrdinalIgnoreCase));
            if (entry is not null && !string.IsNullOrWhiteSpace(entry.Value)) continue;
            diagnostics.Add(new(DiagnosticSeverity.Error, "SEGATOOLS_REQUIRED_PATH_MISSING",
                $"[vfs] {key} 必须填写，否则游戏无法正常启动。", file.Path));
        }
    }

    private static IReadOnlyList<InstalledMod> DiscoverMods(string bepinExPath, CancellationToken cancellationToken)
    {
        var result = new List<InstalledMod>();
        AddMods(Path.Combine(bepinExPath, "monomod"), InstalledModKind.MonoModPatch, result, cancellationToken);
        AddMods(Path.Combine(bepinExPath, "plugins"), InstalledModKind.BepInExPlugin, result, cancellationToken);
        AddMods(Path.Combine(bepinExPath, "disabled"), InstalledModKind.BepInExPlugin, result, cancellationToken, false);
        return result.OrderBy(mod => mod.Kind).ThenBy(mod => mod.Name, StringComparer.OrdinalIgnoreCase).ToArray();
    }

    private static void AddMods(
        string directory,
        InstalledModKind kind,
        ICollection<InstalledMod> target,
        CancellationToken cancellationToken,
        bool defaultEnabled = true)
    {
        if (!Directory.Exists(directory)) return;
        foreach (var path in Directory.EnumerateFiles(directory, "*", SearchOption.TopDirectoryOnly))
        {
            cancellationToken.ThrowIfCancellationRequested();
            var fileName = Path.GetFileName(path);
            var enabledSuffix = kind == InstalledModKind.MonoModPatch ? ".mm.dll" : ".dll";
            var disabledSuffix = enabledSuffix + ".disabled";
            var enabled = defaultEnabled && fileName.EndsWith(enabledSuffix, StringComparison.OrdinalIgnoreCase);
            if (!enabled && !fileName.EndsWith(disabledSuffix, StringComparison.OrdinalIgnoreCase))
                continue;

            var info = new FileInfo(path);
            var technicalName = CleanModName(fileName);
            var catalogEntry = ModCatalog.Describe(technicalName);
            target.Add(new(technicalName, fileName, path, kind, enabled,
                ReadAssemblyVersion(path), info.LastWriteTimeUtc, info.Length, Hash(File.ReadAllBytes(path)),
                catalogEntry.ChineseName, catalogEntry.Description));
        }
    }

    private static string CleanModName(string fileName)
    {
        var name = fileName;
        foreach (var suffix in new[] { ".mm.dll.disabled", ".dll.disabled", ".mm.dll", ".dll" })
            if (name.EndsWith(suffix, StringComparison.OrdinalIgnoreCase))
            {
                name = name[..^suffix.Length];
                break;
            }
        const string prefix = "Assembly-CSharp.";
        return name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ? name[prefix.Length..] : name;
    }

    private static string ReadAssemblyVersion(string path)
    {
        try
        {
            var fileVersion = FileVersionInfo.GetVersionInfo(path).FileVersion;
            if (!string.IsNullOrWhiteSpace(fileVersion)) return fileVersion;
            return AssemblyName.GetAssemblyName(path).Version?.ToString() ?? "未知";
        }
        catch { return "未知"; }
    }

    private static string ReadFileVersion(string path)
    {
        if (!File.Exists(path)) return "未检测到";
        try
        {
            var info = FileVersionInfo.GetVersionInfo(path);
            return info.FileVersion ?? info.ProductVersion ?? "版本未知";
        }
        catch { return "版本未知"; }
    }

    private static string Mask(string value) => value.Length <= 4
        ? new string('•', value.Length)
        : value[..2] + new string('•', Math.Min(12, value.Length - 4)) + value[^2..];

    private static string Key(GameConfigurationFileKind kind, string section, string key) =>
        $"{kind}:{section}:{key}";

    private static IReadOnlyDictionary<string, FieldDefinition> BuildSchema()
    {
        var fields = new Dictionary<string, FieldDefinition>(StringComparer.OrdinalIgnoreCase);
        void Add(GameConfigurationFileKind file, string section, string key, ConfigurationValueKind kind,
            string description, bool sensitive = false, bool addable = false, string defaultValue = "") =>
            fields[Key(file, section, key)] = new(kind, $"{description} · Schema {SchemaVersion}", sensitive,
                addable, defaultValue);
        void AddModded(string section, string key, ConfigurationValueKind kind, string defaultValue,
            string description, params string[] requiredMods) =>
            fields[Key(GameConfigurationFileKind.Mu3, section, key)] = new(kind,
                $"{description} · mu3-mods Wiki · 默认 {defaultValue}", false, true, defaultValue, requiredMods);
        void AddVanilla(string section, string key, ConfigurationValueKind kind, string defaultValue,
            string description) =>
            fields[Key(GameConfigurationFileKind.Mu3, section, key)] = new(kind,
                $"{description} · mu3-mods Wiki 原版配置 · 默认 {defaultValue}", false, true, defaultValue);

        Add(GameConfigurationFileKind.SegaTools, "vfs", "amfs", ConfigurationValueKind.Path, "AMFS 数据目录", addable: true);
        Add(GameConfigurationFileKind.SegaTools, "vfs", "option", ConfigurationValueKind.Path, "Option 数据包目录", addable: true);
        Add(GameConfigurationFileKind.SegaTools, "vfs", "appdata", ConfigurationValueKind.Path, "可写应用数据目录", addable: true);
        Add(GameConfigurationFileKind.SegaTools, "aime", "enable", ConfigurationValueKind.Boolean, "启用 Aime 模拟", addable: true);
        Add(GameConfigurationFileKind.SegaTools, "aime", "aimePath", ConfigurationValueKind.Path, "Aime 卡号文件路径");
        Add(GameConfigurationFileKind.SegaTools, "aime", "aimeGen", ConfigurationValueKind.Boolean, "没有卡号时自动生成 Aime 卡号");
        Add(GameConfigurationFileKind.SegaTools, "aime", "felicaPath", ConfigurationValueKind.Path, "FeliCa ID 文件路径");
        Add(GameConfigurationFileKind.SegaTools, "aime", "portNo", ConfigurationValueKind.Integer, "读卡器 COM 口", defaultValue: "0", addable: true);
        Add(GameConfigurationFileKind.SegaTools, "aime", "scan", ConfigurationValueKind.Text, "按住此键模拟刷卡", defaultValue: "0x0D", addable: true);
        Add(GameConfigurationFileKind.SegaTools, "vfd", "enable", ConfigurationValueKind.Boolean, "启用 VFD 显示模拟");
        Add(GameConfigurationFileKind.SegaTools, "dns", "default", ConfigurationValueKind.Text, "服务器", addable: true);
        Add(GameConfigurationFileKind.SegaTools, "dns", "AimeDB", ConfigurationValueKind.Text, "读卡器服务器", defaultValue: "", addable: true);
        Add(GameConfigurationFileKind.SegaTools, "dns", "replaceHost", ConfigurationValueKind.Boolean, "replaceHost", defaultValue: "0", addable: true);
        Add(GameConfigurationFileKind.SegaTools, "netenv", "enable", ConfigurationValueKind.Boolean, "启用网络环境模拟");
        Add(GameConfigurationFileKind.SegaTools, "keychip", "id", ConfigurationValueKind.Identifier, "Keychip", true, addable: true);
        Add(GameConfigurationFileKind.SegaTools, "keychip", "subnet", ConfigurationValueKind.Text, "Keychip LAN 子网");
        Add(GameConfigurationFileKind.SegaTools, "system", "enable", ConfigurationValueKind.Boolean, "启用 ALLS 系统设置");
        Add(GameConfigurationFileKind.SegaTools, "system", "freeplay", ConfigurationValueKind.Boolean, "启用免费游戏模式");
        Add(GameConfigurationFileKind.SegaTools, "system", "dipsw1", ConfigurationValueKind.Boolean, "局域网主机");
        Add(GameConfigurationFileKind.SegaTools, "gfx", "enable", ConfigurationValueKind.Boolean, "启用图形 Hook");
        Add(GameConfigurationFileKind.SegaTools, "unity", "enable", ConfigurationValueKind.Boolean, "启用 Unity Hook", addable: true);
        Add(GameConfigurationFileKind.SegaTools, "unity", "targetAssembly", ConfigurationValueKind.Path, "启动前加载的 .NET DLL", addable: true);
        Add(GameConfigurationFileKind.SegaTools, "led15093", "enable", ConfigurationValueKind.Boolean, "启用 15093-06 灯光模拟");
        Add(GameConfigurationFileKind.SegaTools, "aimeio", "path", ConfigurationValueKind.Path, "自定义读卡器 IO DLL", addable: true);
        Add(GameConfigurationFileKind.SegaTools, "mu3io", "path", ConfigurationValueKind.Path, "MU3IO 路径", addable: true);
        Add(GameConfigurationFileKind.SegaTools, "io4", "enable", ConfigurationValueKind.Boolean,
            "接管io4", defaultValue: "1", addable: true);
        foreach (var key in new[] { "test", "service", "coin", "mouse", "xinput", "keyboard", "left1", "left2", "left3", "leftSide", "rightSide", "right1", "right2", "right3", "leftMenu", "rightMenu" })
            Add(GameConfigurationFileKind.SegaTools, "io4", key,
                key is "mouse" or "xinput" or "keyboard" ? ConfigurationValueKind.Boolean : ConfigurationValueKind.Text,
                "IO4 输入映射", addable: key is "keyboard" or "mouse", defaultValue: key is "keyboard" ? "1" : "");
        foreach (var key in new[] { "cabLedOutputPipe", "cabLedOutputSerial", "controllerLedOutputPipe", "controllerLedOutputSerial" })
            Add(GameConfigurationFileKind.SegaTools, "led", key, ConfigurationValueKind.Text, "LED 输出通道");
        Add(GameConfigurationFileKind.SegaTools, "led", "serialPort", ConfigurationValueKind.Text, "LED 串口", defaultValue: "COM5", addable: true);
        Add(GameConfigurationFileKind.SegaTools, "led", "serialBaud", ConfigurationValueKind.Integer, "LED 串口波特率");

        Add(GameConfigurationFileKind.Mu3, "AM", "IgnoreError", ConfigurationValueKind.Boolean, "忽略部分 AM 错误");
        Add(GameConfigurationFileKind.Mu3, "AM", "OptionDev", ConfigurationValueKind.Boolean, "启用开发用 Option 目录");
        Add(GameConfigurationFileKind.Mu3, "Sound", "WasapiExclusive", ConfigurationValueKind.Integer, "WASAPI 独占模式；ExclusiveAudio 启用时可设为 2 使用双声道独占");
        Add(GameConfigurationFileKind.Mu3, "Network", "UseLocalCollab", ConfigurationValueKind.Boolean, "使用本地联机协作模式");
        AddVanilla("AM", "PlatformAlls", ConfigurationValueKind.Boolean, "1", "影响 AM 记录的存储位置（Windows 10 及以上）");
        AddVanilla("AM", "DummyJVS", ConfigurationValueKind.Boolean, "0", "JVS 虚拟设备调试项（用途待确认）");
        AddVanilla("AM", "NewButtonAssign", ConfigurationValueKind.Boolean, "0", "未使用的按键分配调试项");
        AddVanilla("AM", "RevertAnalog", ConfigurationValueKind.Boolean, "1", "模拟输入反转调试项（用途待确认）");
        AddVanilla("AM", "InvertWallButtonL", ConfigurationValueKind.Boolean, "1", "左墙按键反转调试项（用途待确认）");
        AddVanilla("AM", "InvertWallButtonR", ConfigurationValueKind.Boolean, "1", "右墙按键反转调试项（用途待确认）");
        AddVanilla("AM", "DummyCredit", ConfigurationValueKind.Boolean, "0", "未使用的投币调试项");
        AddVanilla("AM", "DummyAime", ConfigurationValueKind.Boolean, "0", "未使用的 Aime 调试项");
        AddVanilla("AM", "IgnoreError", ConfigurationValueKind.Boolean, "0", "启动错误时继续运行");
        AddVanilla("AM", "OptionDev", ConfigurationValueKind.Boolean, "0", "0 从 RomConfig.xml 读取 Option 目录；1 使用游戏旁的 option 目录");
        AddVanilla("Network", "UseNetwork", ConfigurationValueKind.Boolean, "1", "关闭仅跳过网络测试，游戏仍可能联网");
        AddVanilla("Network", "UseAllnet", ConfigurationValueKind.Boolean, "1", "关闭可能导致连接到 Sega IP；Wiki 标注为不要修改");
        AddVanilla("Network", "UseLocalCollab", ConfigurationValueKind.Boolean, "1", "启用 cab2cab 本地联机");
        AddVanilla("Network", "ServerURI", ConfigurationValueKind.Text, "", "覆盖服务器 URI");
        AddVanilla("Network", "UseTLS", ConfigurationValueKind.Boolean, "1", "未使用的 TLS 调试项");
        AddVanilla("Device", "CameraType", ConfigurationValueKind.Integer, "1", "设为 0 时请求 640×480@5 的摄像头信号");
        AddVanilla("Keyboard", "KeyInput", ConfigurationValueKind.Boolean, "0", "未使用的键盘输入调试项");
        AddVanilla("Keyboard", "KeyCredit", ConfigurationValueKind.Boolean, "0", "未使用的键盘投币调试项");
        AddVanilla("Keyboard", "KeyDebug", ConfigurationValueKind.Boolean, "0", "未使用的键盘调试项");
        AddVanilla("Sequence", "QuickStart", ConfigurationValueKind.Boolean, "0", "原版未使用；SkipCutscenes 会复用该项");
        AddVanilla("Sequence", "DispDelay", ConfigurationValueKind.Boolean, "0", "未使用的显示延迟调试项");
        AddVanilla("System", "ShiftDays", ConfigurationValueKind.Integer, "0", "将部分日期按指定天数偏移");
        foreach (var key in new[] { "isLoadNoteTap", "isLoadNoteHold", "isLoadNoteFlick", "isLoadBell", "isLoadBullet", "isLoadTapLane", "isLoadWallLane", "isLoadEnemyLane", "isLoadField", "isLoadOneway", "isLoadSoflan" })
            AddVanilla("ScoreReader", key, ConfigurationValueKind.Boolean, "1", "控制谱面解析器是否加载该类对象；关闭可能导致游戏崩溃");
        AddVanilla("ScoreReader", "isSimpleLane", ConfigurationValueKind.Boolean, "0", "使用简化轨道；可能导致游戏崩溃");
        AddModded("Extra", "BGM", ConfigurationValueKind.Integer, "-1", "选择BGM", "SelectBGM");
        AddModded("Extra", "CacheDir", ConfigurationValueKind.Path, ".", "缓存目录", "AttractVideoPlayer", "LoadBoost", "SortByInternalDifficulty");
        AddModded("Extra", "GP", ConfigurationValueKind.Integer, "999", "固定 GP 数值", "DisableGP");
        AddModded("Extra", "ForceEnableTournamentScoreboard", ConfigurationValueKind.Boolean, "1", "强制启用赛事技术分记分板", "ForceEnableTournamentScoreboard");
        AddModded("Extra", "HideCredits", ConfigurationValueKind.Boolean, "1", "隐藏credit或 Free Play", "DisableGP");
        AddModded("Extra", "HideGP", ConfigurationValueKind.Boolean, "1", "隐藏 GP", "DisableGP");
        AddModded("Extra", "HideVersion", ConfigurationValueKind.Boolean, "0", "隐藏游戏版本号", "DisableGP");
        AddModded("Extra", "BlacklistMin", ConfigurationValueKind.Integer, "10000", "拦截成绩上传的最小曲目 ID", "Blacklist", "Inohara");
        AddModded("Extra", "BlacklistMax", ConfigurationValueKind.Integer, "19999", "拦截成绩上传的最大曲目 ID", "Blacklist", "Inohara");
        AddModded("Extra", "UnlockBonusTracks", ConfigurationValueKind.Boolean, "1", "解锁 Bonus Tracks（ID 7000–7999 的角色独唱曲）", "UnlockAllMusic");
        AddModded("Sequence", "SkipCamera", ConfigurationValueKind.Boolean, "1", "开启后跳过二维码摄像头检查", "LoadBoost");
        AddModded("Sequence", "QuickStart", ConfigurationValueKind.Boolean, "0", "开启时默认跳过，关闭时按红色菜单键才跳过", "SkipCutscenes");
        AddModded("Sound", "WasapiExclusive", ConfigurationValueKind.Integer, "1", "默认独占音频模式，开启实现双声道音频", "ExclusiveAudio");
        AddModded("Sound", "SampleRate", ConfigurationValueKind.Integer, "48000", "独占音频模式的采样率", "ExclusiveAudio");
        AddModded("Video", "Framerate", ConfigurationValueKind.Integer, "-1", "帧率上限；设为 0 可解锁帧率", "FrameRate");
        AddModded("Video", "VSync", ConfigurationValueKind.Boolean, "1", "启用时忽略 Framerate 设置", "FrameRate");
        return fields;
    }

    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes));
    private static string EscapePointer(string value) => value.Replace("~", "~0").Replace("/", "~1");

    private sealed record FieldDefinition(
        ConfigurationValueKind Kind,
        string Description,
        bool IsSensitive,
        bool IsAddable = false,
        string DefaultValue = "",
        IReadOnlyList<string>? RequiredMods = null);
}
