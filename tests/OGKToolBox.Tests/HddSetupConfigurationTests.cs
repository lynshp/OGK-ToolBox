using System.Text;
using OGKToolBox.Core.Models;
using OGKToolBox.Infrastructure.Configuration;

namespace OGKToolBox.Tests;

public sealed class HddSetupConfigurationTests
{
    [Theory]
    [InlineData("")]
    [InlineData("; keep header\r\n[unity]\r\n;enable=0\r\n[dns]\r\n;default=old.example\r\n[keychip]\r\n;id=\r\n[custom]\r\nkeep=value\r\n")]
    public async Task WizardCanAddRequiredOptionsToIncompleteIni(string original)
    {
        using var temp = new TempDirectory();
        var token = TestContext.Current.CancellationToken;
        var path = Path.Combine(temp.Path, "segatools.ini");
        await File.WriteAllTextAsync(path, original, new UTF8Encoding(true), token);
        var originalBytes = await File.ReadAllBytesAsync(path, token);
        var installation = new GameInstallation(temp.Path);
        var file = await ReadAsync(installation);
        (string Section, string Key, string Value)[] settings = [
            ("vfs", "amfs", "amfs"), ("vfs", "option", "option"), ("vfs", "appdata", "appdata"),
            ("unity", "enable", "1"), ("unity", "targetAssembly", "BepInEx\\core\\BepInEx.Preloader.dll"),
            ("dns", "default", "play.mumur.net"), ("dns", "AimeDB", "aime.mumur.net"),
            ("keychip", "id", "TEST12345678"),
            ("io4", "keyboard", "0"), ("io4", "mouse", "0"),
            ("mu3io", "path", "NYAGEKI_IO.dll"), ("aimeio", "path", "NYAGEKI_IO.dll"),
            ("aime", "enable", "1")
        ];
        var edits = settings.Select(setting => Edit(file, setting.Section, setting.Key, setting.Value)).ToArray();
        Assert.All(edits, edit => Assert.Equal(0, edit.LineNumber));
        Assert.Equal(originalBytes, await File.ReadAllBytesAsync(path, token));
        var editor = new GameConfigurationEditor();
        var preview = await editor.PreviewAsync(installation, file.Kind, edits, file.ContentHash, token);
        Assert.True(preview.CanSave, string.Join("; ", preview.ValidationErrors));
        var result = await editor.SaveAsync(installation, preview, edits, Path.Combine(temp.Path, "backups"), token);
        var saved = await ReadAsync(installation);
        foreach (var (section, key, value) in settings)
            Assert.Equal(value, Assert.Single(saved.Entries, entry => entry.IsPresent
                && entry.Section.Equals(section, StringComparison.OrdinalIgnoreCase)
                && entry.Key.Equals(key, StringComparison.OrdinalIgnoreCase)).Value);
        Assert.Equal(originalBytes, await File.ReadAllBytesAsync(result.BackupPath, token));
        var savedText = await File.ReadAllTextAsync(path, token);
        foreach (var line in original.Split("\r\n", StringSplitOptions.RemoveEmptyEntries))
            Assert.Contains(line + "\r\n", savedText);
        Assert.True((await File.ReadAllBytesAsync(path, token)).AsSpan().StartsWith(Encoding.UTF8.GetPreamble()));
    }

    [Fact]
    public async Task AddingAimedbBeforeExistingKeychipDoesNotShiftTheKeychipEdit()
    {
        using var temp = new TempDirectory();
        var token = TestContext.Current.CancellationToken;
        var path = Path.Combine(temp.Path, "segatools.ini");
        const string original = "[dns]\r\ndefault=old.example\r\n[keychip]\r\nid=OLD123456789\r\n[custom]\r\nkeep=unchanged\r\n";
        await File.WriteAllTextAsync(path, original, token);
        var installation = new GameInstallation(temp.Path);
        var file = await ReadAsync(installation);
        ConfigurationEdit[] edits = [Edit(file, "dns", "default", "play.mumur.net"),
            Edit(file, "dns", "AimeDB", "aime.mumur.net"), Edit(file, "keychip", "id", "NEW123456789")];
        var editor = new GameConfigurationEditor();
        var preview = await editor.PreviewAsync(installation, file.Kind, edits, file.ContentHash, token);
        Assert.True(preview.CanSave, string.Join("; ", preview.ValidationErrors));
        await editor.SaveAsync(installation, preview, edits, Path.Combine(temp.Path, "backups"), token);
        Assert.Equal("[dns]\r\ndefault=play.mumur.net\r\nAimeDB=aime.mumur.net\r\n[keychip]\r\nid=NEW123456789\r\n[custom]\r\nkeep=unchanged\r\n",
            await File.ReadAllTextAsync(path, token));
    }

    [Fact]
    public async Task RemovingOldAimedbPlaceholdersDoesNotShiftLaterKeychipComment()
    {
        using var temp = new TempDirectory();
        var token = TestContext.Current.CancellationToken;
        var path = Path.Combine(temp.Path, "segatools.ini");
        await File.WriteAllTextAsync(path,
            "[dns]\n;AimeDB=\ndefault=old.example\nAimeDB=aime.old.example\n[keychip]\nid=TEST12345678\n[custom]\nkeep=unchanged\n", token);
        var installation = new GameInstallation(temp.Path);
        var file = await ReadAsync(installation);
        ConfigurationEdit[] edits = [Edit(file, "dns", "default", "nageki-net.com"),
            Edit(file, "dns", "AimeDB", "") with { Remove = true }, Edit(file, "keychip", "id", "")];
        var editor = new GameConfigurationEditor();
        var preview = await editor.PreviewAsync(installation, file.Kind, edits, file.ContentHash, token);
        Assert.True(preview.CanSave, string.Join("; ", preview.ValidationErrors));
        await editor.SaveAsync(installation, preview, edits, Path.Combine(temp.Path, "backups"), token);
        Assert.Equal("[dns]\ndefault=nageki-net.com\n;AimeDB=\n[keychip]\n;id=\n[custom]\nkeep=unchanged\n",
            await File.ReadAllTextAsync(path, token));
    }

    private static async Task<ConfigurationFileSnapshot> ReadAsync(GameInstallation installation)
    {
        var snapshot = await new GameConfigurationInspector().InspectAsync(installation, TestContext.Current.CancellationToken);
        return Assert.Single(snapshot.Files, file => file.Kind == GameConfigurationFileKind.SegaTools);
    }

    private static ConfigurationEdit Edit(ConfigurationFileSnapshot file, string section, string key, string value)
    {
        var entry = Assert.Single(file.Entries, entry => entry.Section.Equals(section, StringComparison.OrdinalIgnoreCase)
            && entry.Key.Equals(key, StringComparison.OrdinalIgnoreCase));
        return new(entry.LineNumber, entry.Locator, entry.Value, value, entry.Section, entry.Key);
    }
}
