using Microsoft.Data.Sqlite;
using OGKToolBox.Core.Models;
using OGKToolBox.Infrastructure.Charts;
using OGKToolBox.Infrastructure.Indexing;
using OGKToolBox.Infrastructure.Scanning;

namespace OGKToolBox.Tests;

public sealed class LibraryScannerTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DuplicateFilesDoNotBlockIndexAndPackageOverridesRemainEffective(bool incremental)
    {
        using var temp = new TempDirectory();
        var installation = new GameInstallation(temp.Path);
        Directory.CreateDirectory(installation.BaseGameDataPath);
        var index = new SqliteLibraryIndex(Path.Combine(temp.Path, "cache.db"));
        var scanner = new LibraryScanner(new DataPackageResolver(), new MusicMetadataReader(new OgkrSerializer()), index);
        var roots = new[] { installation.BaseAssetsPath, Path.Combine(installation.OptionPath, "A001", "assets") };
        foreach (var root in roots)
        {
            // Create the backup first to prove the selected file does not depend on enumeration order.
            Directory.CreateDirectory(Path.Combine(root, "backup"));
            File.WriteAllText(Path.Combine(root, "backup", "UI_JACKET_000001"), "UnityFS backup");
            File.WriteAllText(Path.Combine(root, "ui_jacket_000001"), "UnityFS original");
            File.WriteAllText(Path.Combine(root, "ui_jacket_000002"), "UnityFS other");
        }
        var full = await scanner.ScanAsync(installation, null, CancellationToken.None);
        var snapshot = incremental ? await scanner.ScanOptionAsync(installation, full, null, CancellationToken.None) : full;
        Assert.Equal(4, snapshot.Resources.Count);
        Assert.All(snapshot.Resources.Where(item => item.Origin.IsEffective), item => Assert.Equal("A001", item.Origin.PackageId));
        Assert.DoesNotContain(snapshot.Resources, item => item.BundlePath.Contains("backup"));
        var duplicates = snapshot.Diagnostics.Where(item => item.Code == "RESOURCE_DUPLICATE").ToArray();
        Assert.Equal(2, duplicates.Length);
        Assert.All(duplicates, item =>
        {
            Assert.Equal(DiagnosticSeverity.Error, item.Severity);
            Assert.Contains("已使用：", item.Message);
            Assert.Contains("已跳过：", item.Message);
            Assert.True(File.Exists(item.SourcePath));
        });
        var restored = await index.LoadAsync(installation, CancellationToken.None);
        Assert.NotNull(restored);
        Assert.Equal(4, restored.Resources.Count);
        Assert.Equal(2, restored.Diagnostics.Count(item => item.Code == "RESOURCE_DUPLICATE"));
        // Removing an Option duplicate and retrying must remove its old report too.
        File.Delete(Path.Combine(roots[1], "backup", "UI_JACKET_000001"));
        var rescanned = incremental ? await scanner.ScanOptionAsync(installation, snapshot, null, CancellationToken.None)
            : await scanner.ScanAsync(installation, null, CancellationToken.None);
        Assert.Single(rescanned.Diagnostics, item => item.Code == "RESOURCE_DUPLICATE");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task IgnoresUnityMetadataInFullAndOptionScans(bool incremental)
    {
        using var temp = new TempDirectory();
        var installation = new GameInstallation(temp.Path);
        Directory.CreateDirectory(installation.BaseGameDataPath);
        var index = new SqliteLibraryIndex(Path.Combine(temp.Path, "cache.db"));
        var scanner = new LibraryScanner(new DataPackageResolver(), new MusicMetadataReader(new OgkrSerializer()), index);
        var cached = await scanner.ScanAsync(installation, null, CancellationToken.None);
        foreach (var root in new[] { installation.BaseAssetsPath, Path.Combine(installation.OptionPath, "A001", "assets") })
        {
            Directory.CreateDirectory(root);
            File.WriteAllText(Path.Combine(root, "anm_chara_00100001"), "UnityFS");
            File.WriteAllText(Path.Combine(root, "ui_jacket_000001"), "UnityFS");
            File.WriteAllText(Path.Combine(root, "anm_chara_00100001.meta"), "fileFormatVersion: 2");
            File.WriteAllText(Path.Combine(root, "ui_jacket_000001.META"), "UnityFS");
            File.WriteAllText(Path.Combine(root, "unknown.meta"), "UnityFS");
        }
        // Full scan seeds the base cache; Option refresh must still ignore sidecars.
        cached = await scanner.ScanAsync(installation, null, CancellationToken.None);
        var snapshot = incremental
            ? await scanner.ScanOptionAsync(installation, cached, null, CancellationToken.None)
            : cached;
        Assert.Equal(4, snapshot.Resources.Count);
        Assert.DoesNotContain(snapshot.Resources, item => item.BundlePath.EndsWith(".meta", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(snapshot.Diagnostics, item => item.Code == "BUNDLE_HEADER_INVALID");
        Assert.Equal(2, snapshot.Resources.Count(item => item.Origin.IsEffective));
        Assert.All(snapshot.Resources.Where(item => item.Origin.IsEffective), item => Assert.Equal("A001", item.Origin.PackageId));
    }

    [Theory]
    [InlineData("4")]
    [InlineData("5")]
    public async Task RebuildsOldIndexesInsteadOfRestoringMisclassifiedMetadata(string schema)
    {
        using var temp = new TempDirectory();
        var installation = new GameInstallation(temp.Path);
        Directory.CreateDirectory(installation.BaseGameDataPath);
        var database = Path.Combine(temp.Path, "cache.db");
        var index = new SqliteLibraryIndex(database);
        var scanner = new LibraryScanner(new DataPackageResolver(), new MusicMetadataReader(new OgkrSerializer()), index);
        await scanner.ScanAsync(installation, null, CancellationToken.None);
        await using (var connection = new SqliteConnection($"Data Source={database}"))
        {
            await connection.OpenAsync(TestContext.Current.CancellationToken);
            var command = connection.CreateCommand();
            command.CommandText = "UPDATE library_state SET value = $schema WHERE key = 'cache_schema'";
            command.Parameters.AddWithValue("$schema", schema);
            await command.ExecuteNonQueryAsync(TestContext.Current.CancellationToken);
        }
        Assert.Null(await scanner.LoadCachedAsync(installation, CancellationToken.None));
        Assert.Null(await index.GetCountsAsync(installation, CancellationToken.None));
        Assert.False(await index.IsAmfsCurrentAsync(installation, CancellationToken.None));
        await scanner.ScanAsync(installation, null, CancellationToken.None);
        Assert.NotNull(await scanner.LoadCachedAsync(installation, CancellationToken.None));
    }
}
