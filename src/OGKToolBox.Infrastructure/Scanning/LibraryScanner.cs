using System.Collections.Concurrent;
using System.Diagnostics;
using System.Xml.Linq;
using OGKToolBox.Core.Abstractions;
using OGKToolBox.Core.Models;

namespace OGKToolBox.Infrastructure.Scanning;

public sealed class LibraryScanner(
    IDataPackageResolver packageResolver,
    IMusicMetadataReader musicReader,
    ILibraryIndex index) : ILibraryScanner
{
    public async Task<LibrarySnapshot?> LoadCachedAsync(
        GameInstallation installation,
        CancellationToken cancellationToken)
    {
        await index.InitializeAsync(cancellationToken);
        return await index.LoadAsync(installation, cancellationToken);
    }

    public async Task<LibrarySnapshot> ScanOptionAsync(
        GameInstallation installation,
        LibrarySnapshot cached,
        IProgress<ScanProgress>? progress,
        CancellationToken cancellationToken)
    {
        var packages = await packageResolver.DiscoverAsync(installation, cancellationToken);
        var optionPackages = packages.Where(package => !package.IsBaseGame).ToArray();
        var resourceVariants = cached.Resources
            .Where(resource => resource.Origin.PackageId.Equals("A000", StringComparison.OrdinalIgnoreCase)
                && !IsUnityMetadata(resource.BundlePath))
            .Select(resource => resource with { Origin = resource.Origin with { IsEffective = false } })
            .ToList();
        var diagnostics = new ConcurrentBag<LibraryDiagnostic>(cached.Diagnostics.Where(diagnostic =>
            diagnostic.SourcePath is null || (!IsInsideOption(installation, diagnostic.SourcePath)
                && !IsUnityMetadata(diagnostic.SourcePath))));
        progress?.Report(new("更新 Option 资源", 0, Math.Max(optionPackages.Length, 1)));

        for (var indexValue = 0; indexValue < optionPackages.Length; indexValue++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var package = optionPackages[indexValue];
            foreach (var assetRoot in ResourceRoots(installation, package))
            {
                if (!Directory.Exists(assetRoot)) continue;
                foreach (var path in Directory.EnumerateFiles(assetRoot, "*", SearchOption.AllDirectories))
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (IsUnityMetadata(path)) continue;
                    var name = Path.GetFileName(path);
                    var kind = Classify(name);
                    var isUnityBundle = LooksLikeUnityBundle(path);
                    if (kind == ResourceKind.Unknown && !isUnityBundle) continue;
                    if (kind is ResourceKind.Jacket or ResourceKind.Card or ResourceKind.CardCharacter
                        or ResourceKind.CardIcon or ResourceKind.Character or ResourceKind.ChapterCharacter
                        or ResourceKind.UserPlate && !isUnityBundle)
                        diagnostics.Add(new(DiagnosticSeverity.Error, "BUNDLE_HEADER_INVALID", "资源不是有效的 UnityFS Bundle。", path));
                    var info = new FileInfo(path);
                    resourceVariants.Add(new(name, kind, path, info.Length,
                        new(package.Id, path, package.LoadOrder)));
                }
            }
            progress?.Report(new("更新 Option 资源", indexValue + 1, Math.Max(optionPackages.Length, 1), package.Id));
        }

        resourceVariants = ResolveDuplicateResources(resourceVariants, diagnostics);
        var effectiveResources = resourceVariants
            .GroupBy(resource => resource.Key, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(group => group.Key, group => group.MaxBy(resource => resource.Origin.LoadOrder)!, StringComparer.OrdinalIgnoreCase);
        var resources = resourceVariants.Select(resource => resource with
        {
            Origin = resource.Origin with { IsEffective = ReferenceEquals(effectiveResources[resource.Key], resource) }
        }).ToArray();
        var resourceLookup = resources.Where(resource => resource.Origin.IsEffective)
            .ToDictionary(resource => resource.Key, StringComparer.OrdinalIgnoreCase);

        var optionMusicFiles = optionPackages.SelectMany(package => EnumerateXml(package, "music", "Music.xml")).ToArray();
        var optionCardFiles = optionPackages.SelectMany(package => EnumerateXml(package, "card", "Card.xml")).ToArray();
        var optionCharacterFiles = optionPackages.SelectMany(package => EnumerateXml(package, "chara", "Chara.xml")).ToArray();
        var total = optionMusicFiles.Length + optionCardFiles.Length + optionCharacterFiles.Length;
        var complete = 0;
        var music = cached.MusicVariants.Where(item => item.Origin.PackageId.Equals("A000", StringComparison.OrdinalIgnoreCase)).ToList();
        var cards = cached.Cards.Where(item => item.Origin.PackageId.Equals("A000", StringComparison.OrdinalIgnoreCase)).ToList();
        var characters = cached.Characters.Where(item => item.Origin.PackageId.Equals("A000", StringComparison.OrdinalIgnoreCase)).ToList();

        foreach (var item in optionMusicFiles)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try { music.Add(musicReader.Read(item.Path, item.Package, resourceLookup)); }
            catch (Exception exception) when (exception is not OperationCanceledException)
            { diagnostics.Add(new(DiagnosticSeverity.Error, "MUSIC_XML_FAILED", exception.Message, item.Path)); }
            progress?.Report(new("读取 Option 元数据", ++complete, total, item.Path));
        }
        foreach (var item in optionCardFiles)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try { cards.Add(ReadCard(item.Path, item.Package, resourceLookup)); }
            catch (Exception exception) when (exception is not OperationCanceledException)
            { diagnostics.Add(new(DiagnosticSeverity.Error, "CARD_XML_FAILED", exception.Message, item.Path)); }
            progress?.Report(new("读取 Option 元数据", ++complete, total, item.Path));
        }
        var effectiveCards = Effective(cards, model => model.Id, model => model.Origin.LoadOrder);
        foreach (var item in optionCharacterFiles)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try { characters.Add(ReadCharacter(item.Path, item.Package, resourceLookup, effectiveCards)); }
            catch (Exception exception) when (exception is not OperationCanceledException)
            { diagnostics.Add(new(DiagnosticSeverity.Error, "CHARA_XML_FAILED", exception.Message, item.Path)); }
            progress?.Report(new("读取 Option 元数据", ++complete, total, item.Path));
        }

        var effectiveMusic = music.GroupBy(model => model.Id)
            .Select(group => group.MaxBy(model => model.Origin.LoadOrder)!)
            .OrderBy(model => model.Id)
            .Select(model => model with { Origin = model.Origin with { IsEffective = true } })
            .ToArray();
        var duplicateIds = music.GroupBy(model => model.Id).Where(group => group.Count() > 1);
        foreach (var duplicate in duplicateIds)
            diagnostics.Add(new(DiagnosticSeverity.Warning, "MUSIC_OVERRIDE",
                $"乐曲 ID {duplicate.Key} 有 {duplicate.Count()} 个来源，已按 Option 顺序选择最终版本。"));

        var snapshot = new LibrarySnapshot
        {
            Installation = installation,
            GameVersion = cached.GameVersion ?? GameVersionInfo.FromDataPackages(packages),
            Packages = packages,
            MusicVariants = music.OrderBy(model => model.Id).ThenBy(model => model.Origin.LoadOrder).ToArray(),
            EffectiveMusic = effectiveMusic,
            Cards = effectiveCards,
            Characters = Effective(characters, model => model.Id, model => model.Origin.LoadOrder),
            Resources = resources,
            Diagnostics = diagnostics.OrderByDescending(diagnostic => diagnostic.Severity).ThenBy(diagnostic => diagnostic.Code).ToArray()
        };
        await index.SaveAsync(snapshot, cancellationToken);
        progress?.Report(new("完成", 1, 1));
        return snapshot;
    }

    public async Task<LibrarySnapshot> ScanAsync(
        GameInstallation installation,
        IProgress<ScanProgress>? progress,
        CancellationToken cancellationToken)
    {
        var packages = await packageResolver.DiscoverAsync(installation, cancellationToken);
        var gameVersion = GameVersionInfo.FromDataPackages(packages);
        var diagnostics = new ConcurrentBag<LibraryDiagnostic>();
        progress?.Report(new("发现数据包", 0, packages.Count));

        var resourceFiles = new List<(string Path, DataPackage Package)>();
        var preparationReporter = new ScanProgressReporter(progress, 0);
        for (var packageIndex = 0; packageIndex < packages.Count; packageIndex++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var package = packages[packageIndex];
            foreach (var assetRoot in ResourceRoots(installation, package))
            {
                if (!Directory.Exists(assetRoot)) continue;
                foreach (var path in Directory.EnumerateFiles(assetRoot, "*", SearchOption.AllDirectories))
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (IsUnityMetadata(path)) continue;
                    resourceFiles.Add((path, package));
                    preparationReporter.Report("建立资源文件清单", resourceFiles.Count, 0, path, 0);
                }
            }
        }

        var musicFiles = new List<(string Path, DataPackage Package)>();
        var cardFiles = new List<(string Path, DataPackage Package)>();
        var characterFiles = new List<(string Path, DataPackage Package)>();
        for (var packageIndex = 0; packageIndex < packages.Count; packageIndex++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var package = packages[packageIndex];
            foreach (var item in EnumerateXml(package, "music", "Music.xml"))
            {
                musicFiles.Add(item);
                preparationReporter.Report("建立元数据清单", musicFiles.Count + cardFiles.Count + characterFiles.Count, 0, item.Path, 0);
            }
            foreach (var item in EnumerateXml(package, "card", "Card.xml"))
            {
                cardFiles.Add(item);
                preparationReporter.Report("建立元数据清单", musicFiles.Count + cardFiles.Count + characterFiles.Count, 0, item.Path, 0);
            }
            foreach (var item in EnumerateXml(package, "chara", "Chara.xml"))
            {
                characterFiles.Add(item);
                preparationReporter.Report("建立元数据清单", musicFiles.Count + cardFiles.Count + characterFiles.Count, 0, item.Path, 0);
            }
        }

        var totalMetadata = musicFiles.Count + cardFiles.Count + characterFiles.Count;
        var overallTotal = resourceFiles.Count + totalMetadata + 1;
        var progressReporter = new ScanProgressReporter(progress, overallTotal);
        var resourceVariants = new List<GameResource>();
        progressReporter.Report("枚举资源", 0, resourceFiles.Count, null, 0, true);
        for (var indexValue = 0; indexValue < resourceFiles.Count; indexValue++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var (path, package) = resourceFiles[indexValue];
            var name = Path.GetFileName(path);
            var kind = Classify(name);
            var needsBundleCheck = kind is not ResourceKind.Audio and not ResourceKind.Movie
                && (kind != ResourceKind.Unknown || MayContainUnityBundle(path));
            var isUnityBundle = needsBundleCheck && LooksLikeUnityBundle(path);
            if (kind == ResourceKind.Unknown && !isUnityBundle)
            {
                progressReporter.Report("枚举资源", indexValue + 1, resourceFiles.Count, path, indexValue + 1);
                continue;
            }

            if (kind is ResourceKind.Jacket or ResourceKind.Card or ResourceKind.CardCharacter
                or ResourceKind.CardIcon or ResourceKind.Character or ResourceKind.ChapterCharacter
                or ResourceKind.UserPlate && !isUnityBundle)
            {
                diagnostics.Add(new(DiagnosticSeverity.Error, "BUNDLE_HEADER_INVALID", "资源不是有效的 UnityFS Bundle。", path));
            }

            var info = new FileInfo(path);
            resourceVariants.Add(new(name, kind, path, info.Length,
                new(package.Id, path, package.LoadOrder)));
            progressReporter.Report("枚举资源", indexValue + 1, resourceFiles.Count, path, indexValue + 1);
        }

        resourceVariants = ResolveDuplicateResources(resourceVariants, diagnostics);
        var effectiveResources = resourceVariants
            .GroupBy(resource => resource.Key, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(group => group.Key, group => group.MaxBy(resource => resource.Origin.LoadOrder)!, StringComparer.OrdinalIgnoreCase);
        var resources = resourceVariants.Select(resource => resource with
        {
            Origin = resource.Origin with { IsEffective = ReferenceEquals(effectiveResources[resource.Key], resource) }
        }).ToArray();

        var total = totalMetadata;
        var complete = 0;
        var overallCompleted = resourceFiles.Count;
        var music = new List<Music>(musicFiles.Count);
        var cards = new List<Card>(cardFiles.Count);
        var characters = new List<Character>(characterFiles.Count);

        progressReporter.Report("读取元数据", 0, total, null, overallCompleted, true);

        foreach (var item in musicFiles)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                var model = musicReader.Read(item.Path, item.Package, effectiveResources);
                music.Add(model);
                if (model.Jacket is null)
                {
                    diagnostics.Add(new(DiagnosticSeverity.Warning, "MUSIC_JACKET_MISSING", $"{model.Title} 缺少封面资源。", item.Path));
                }
                if (model.Audio is null)
                {
                    diagnostics.Add(new(DiagnosticSeverity.Warning, "MUSIC_AUDIO_MISSING", $"{model.Title} 缺少音频。", item.Path));
                }
                foreach (var chart in model.Charts.Where(chart => !chart.Exists))
                {
                    diagnostics.Add(new(DiagnosticSeverity.Warning, "CHART_FILE_MISSING", $"谱面文件不存在：{chart.FilePath}", item.Path));
                }
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                diagnostics.Add(new(DiagnosticSeverity.Error, "MUSIC_XML_FAILED", exception.Message, item.Path));
            }
            progressReporter.Report("读取元数据", ++complete, total, item.Path, ++overallCompleted);
        }

        foreach (var item in cardFiles)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try { cards.Add(ReadCard(item.Path, item.Package, effectiveResources)); }
            catch (Exception exception) when (exception is not OperationCanceledException)
            { diagnostics.Add(new(DiagnosticSeverity.Error, "CARD_XML_FAILED", exception.Message, item.Path)); }
            progressReporter.Report("读取元数据", ++complete, total, item.Path, ++overallCompleted);
        }

        var effectiveCards = Effective(cards, model => model.Id, model => model.Origin.LoadOrder);

        foreach (var item in characterFiles)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try { characters.Add(ReadCharacter(item.Path, item.Package, effectiveResources, effectiveCards)); }
            catch (Exception exception) when (exception is not OperationCanceledException)
            { diagnostics.Add(new(DiagnosticSeverity.Error, "CHARA_XML_FAILED", exception.Message, item.Path)); }
            progressReporter.Report("读取元数据", ++complete, total, item.Path, ++overallCompleted);
        }

        var effectiveMusic = music.GroupBy(model => model.Id)
            .Select(group => group.MaxBy(model => model.Origin.LoadOrder)!)
            .OrderBy(model => model.Id)
            .Select(model => model with { Origin = model.Origin with { IsEffective = true } })
            .ToArray();
        var duplicateIds = music.GroupBy(model => model.Id).Where(group => group.Count() > 1);
        foreach (var duplicate in duplicateIds)
        {
            diagnostics.Add(new(DiagnosticSeverity.Warning, "MUSIC_OVERRIDE",
                $"乐曲 ID {duplicate.Key} 有 {duplicate.Count()} 个来源，已按 Option 顺序选择最终版本。"));
        }

        var snapshot = new LibrarySnapshot
        {
            Installation = installation,
            GameVersion = gameVersion,
            Packages = packages,
            MusicVariants = music.OrderBy(model => model.Id).ThenBy(model => model.Origin.LoadOrder).ToArray(),
            EffectiveMusic = effectiveMusic,
            Cards = effectiveCards,
            Characters = Effective(characters, model => model.Id, model => model.Origin.LoadOrder),
            Resources = resources,
            Diagnostics = diagnostics.OrderByDescending(diagnostic => diagnostic.Severity).ThenBy(diagnostic => diagnostic.Code).ToArray()
        };

        progressReporter.Report("更新索引", 0, 1, null, overallCompleted, true);
        await index.InitializeAsync(cancellationToken);
        await index.SaveAsync(snapshot, cancellationToken);
        progressReporter.Report("完成", 1, 1, null, overallTotal, true);
        return snapshot;
    }

    // One physical file per logical resource within a package. Keep package override ordering intact.
    private static List<GameResource> ResolveDuplicateResources(
        IEnumerable<GameResource> source, ConcurrentBag<LibraryDiagnostic> diagnostics)
    {
        var selected = new List<GameResource>();
        foreach (var package in source.GroupBy(item => item.Origin.PackageId, StringComparer.OrdinalIgnoreCase))
        foreach (var group in package.GroupBy(item => item.Key, StringComparer.OrdinalIgnoreCase))
        {
            // Prefer the shallowest path, then use an ordinal path order so scans never depend on enumeration order.
            var ordered = group.OrderBy(item => item.BundlePath.Count(character => character is '/' or '\\'))
                .ThenBy(item => item.BundlePath, StringComparer.OrdinalIgnoreCase)
                .ThenBy(item => item.BundlePath, StringComparer.Ordinal).ToArray();
            var chosen = ordered[0];
            selected.Add(chosen);
            foreach (var duplicate in ordered.Skip(1))
                diagnostics.Add(new(DiagnosticSeverity.Error, "RESOURCE_DUPLICATE",
                    $"数据包 {package.Key} 中有重名资源“{chosen.Key}”。已继续加载，同包内优先使用目录层级较浅的文件；层级相同时按路径名称排序选择。" +
                    $"\n已使用：{chosen.BundlePath}\n已跳过：{duplicate.BundlePath}\n没有删除或修改这些文件，请核对是否混入备份或重复解压的文件。",
                    duplicate.BundlePath));
        }
        return selected;
    }

    private static IReadOnlyList<T> Effective<T, TKey>(IEnumerable<T> source, Func<T, TKey> key, Func<T, int> order)
        where TKey : notnull => source.GroupBy(key).Select(group => group.MaxBy(order)!).ToArray();

    private static IEnumerable<(string Path, DataPackage Package)> EnumerateXml(DataPackage package, string category, string name)
    {
        var root = Path.Combine(package.RootPath, category);
        return Directory.Exists(root)
            ? Directory.EnumerateFiles(root, name, SearchOption.AllDirectories).Select(path => (path, package))
            : [];
    }

    private static bool IsInsideOption(GameInstallation installation, string path)
    {
        var optionRoot = Path.GetFullPath(installation.OptionPath).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (Path.GetFullPath(path).StartsWith(optionRoot, StringComparison.OrdinalIgnoreCase)) return true;
        var relative = Path.GetRelativePath(installation.GameDataPath, path);
        var packageId = relative.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)[0];
        return packageId.Length == 4 && char.ToUpperInvariant(packageId[0]) == 'A'
            && packageId[1..].All(char.IsLetterOrDigit)
            && !packageId.Equals("A000", StringComparison.OrdinalIgnoreCase);
    }

    private static IEnumerable<string> ResourceRoots(GameInstallation installation, DataPackage package)
    {
        yield return package.IsBaseGame ? installation.BaseAssetsPath : Path.Combine(package.RootPath, "assets");
        yield return Path.Combine(package.RootPath, "musicsource");
        yield return Path.Combine(package.RootPath, "movie");
    }

    private static bool IsUnityMetadata(string path) =>
        Path.GetExtension(path).Equals(".meta", StringComparison.OrdinalIgnoreCase);

    private static bool LooksLikeUnityBundle(string path)
    {
        try
        {
            Span<byte> header = stackalloc byte[7];
            using var stream = File.OpenRead(path);
            return stream.Read(header) == header.Length && header.SequenceEqual("UnityFS"u8);
        }
        catch { return false; }
    }

    private static bool MayContainUnityBundle(string path) => Path.GetExtension(path).ToLowerInvariant() switch
    {
        ".xml" or ".ogkr" or ".db" or ".ps1" or ".json" or ".csv" or ".txt" or ".ini" => false,
        _ => true
    };

    private static ResourceKind Classify(string name)
    {
        if (name.StartsWith("ui_jacket_", StringComparison.OrdinalIgnoreCase)) return ResourceKind.Jacket;
        if (name.StartsWith("ui_card_chara_", StringComparison.OrdinalIgnoreCase)) return ResourceKind.CardCharacter;
        if (name.StartsWith("ui_card_icon_", StringComparison.OrdinalIgnoreCase)) return ResourceKind.CardIcon;
        if (name.StartsWith("ui_card_", StringComparison.OrdinalIgnoreCase)) return ResourceKind.Card;
        if (name.StartsWith("ui_chapter_chara_", StringComparison.OrdinalIgnoreCase)) return ResourceKind.ChapterCharacter;
        if (name.StartsWith("anm_chara_", StringComparison.OrdinalIgnoreCase)) return ResourceKind.Character;
        if (name.StartsWith("ui_userplate_", StringComparison.OrdinalIgnoreCase)) return ResourceKind.UserPlate;
        if (name.EndsWith(".acb", StringComparison.OrdinalIgnoreCase) || name.EndsWith(".awb", StringComparison.OrdinalIgnoreCase)) return ResourceKind.Audio;
        if (name.EndsWith(".usm", StringComparison.OrdinalIgnoreCase)) return ResourceKind.Movie;
        return ResourceKind.Unknown;
    }

    private sealed class ScanProgressReporter(IProgress<ScanProgress>? progress, int overallTotal)
    {
        private long _lastReportTimestamp;

        public void Report(
            string phase,
            int completed,
            int total,
            string? currentPath,
            int overallCompleted,
            bool force = false)
        {
            if (progress is null) return;
            var now = Stopwatch.GetTimestamp();
            var interval = Math.Max(1, Stopwatch.Frequency / 10);
            if (!force && (total <= 0 || completed < total) && now - _lastReportTimestamp < interval) return;
            _lastReportTimestamp = now;
            progress.Report(new(phase, completed, total, currentPath, overallCompleted, overallTotal));
        }
    }

    private static Card ReadCard(string path, DataPackage package, IReadOnlyDictionary<string, GameResource> resources)
    {
        var root = XDocument.Load(path).Root ?? throw new InvalidDataException("Card.xml 没有根节点。");
        var id = XmlInt(root, "Name/id");
        return new(id, Xml(root, "dataName"), Xml(root, "Name/str"), XmlInt(root, "CharaID/id"), Xml(root, "CharaID/str"),
            Xml(root, "NickName"), Xml(root, "Rarity"), Xml(root, "Attribute"),
            Resource(resources, $"ui_card_{id:D6}", ResourceKind.Card),
            Resource(resources, $"ui_card_chara_{id:D6}", ResourceKind.CardCharacter),
            Resource(resources, $"ui_card_chara_{id:D6}_p", ResourceKind.CardCharacter),
            Resource(resources, $"ui_card_icon_{id:D6}", ResourceKind.CardIcon),
            new(package.Id, path, package.LoadOrder));
    }

    private static Character ReadCharacter(
        string path,
        DataPackage package,
        IReadOnlyDictionary<string, GameResource> resources,
        IReadOnlyList<Card> cards)
    {
        var root = XDocument.Load(path).Root ?? throw new InvalidDataException("Chara.xml 没有根节点。");
        var id = XmlInt(root, "Name/id");
        var graphicCardId = XmlInt(root, "GraphicCardData/id");
        var images = new List<ResourceReference>();
        foreach (var candidate in new[]
        {
            ($"ui_card_chara_{graphicCardId:D6}", ResourceKind.CardCharacter),
            ($"ui_card_chara_{graphicCardId:D6}_p", ResourceKind.CardCharacter),
            ($"ui_card_{graphicCardId:D6}", ResourceKind.Card),
            ($"ui_card_icon_{graphicCardId:D6}", ResourceKind.CardIcon)
        })
        {
            if (resources.TryGetValue(candidate.Item1, out var resource))
                images.Add(new(resource.Key, resource.BundlePath, candidate.Item2));
        }
        foreach (var card in cards.Where(card => card.CharacterId == id).OrderBy(card => card.Id))
        {
            if (card.CharacterImage is not null) images.Add(card.CharacterImage);
            if (card.FullIllustration is not null) images.Add(card.FullIllustration);
        }
        images = images.DistinctBy(image => image.BundlePath, StringComparer.OrdinalIgnoreCase).ToList();
        return new(id, Xml(root, "dataName"), Xml(root, "Name/str"), XmlInt(root, "Model/id"),
            graphicCardId, Xml(root, "FlavorText"), images,
            new(package.Id, path, package.LoadOrder));
    }

    private static ResourceReference? Resource(IReadOnlyDictionary<string, GameResource> resources, string key, ResourceKind kind) =>
        resources.TryGetValue(key, out var resource) ? new(resource.Key, resource.BundlePath, kind) : null;

    private static string Xml(XElement root, string path) => path.Split('/').Aggregate((XElement?)root, (current, name) => current?.Element(name))?.Value.Trim() ?? string.Empty;
    private static int XmlInt(XElement root, string path) => int.TryParse(Xml(root, path), out var value) ? value : 0;
}
