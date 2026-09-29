using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using OGKToolBox.Core.Abstractions;
using OGKToolBox.Core.Models;

namespace OGKToolBox.Infrastructure.Indexing;

public sealed class SqliteLibraryIndex : ILibraryIndex
{
    private const string CacheSchemaVersion = "6";
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.General);
    private readonly string? _databasePathOverride;

    public SqliteLibraryIndex() { }
    public SqliteLibraryIndex(string databasePath) => _databasePathOverride = databasePath;

    public Task InitializeAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public async Task<LibrarySnapshot?> LoadAsync(GameInstallation installation, CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(installation, cancellationToken);
        var command = connection.CreateCommand();
        command.CommandText = "SELECT key, value FROM library_state WHERE key IN ('cache_schema','game_root','source_stamp','snapshot_json');";
        var state = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken)) state[reader.GetString(0)] = reader.GetString(1);

        if (!state.TryGetValue("cache_schema", out var schema) || schema != CacheSchemaVersion
            || !state.TryGetValue("game_root", out var root)
            || !Path.GetFullPath(root).Equals(Path.GetFullPath(installation.RootPath), StringComparison.OrdinalIgnoreCase)
            || !state.TryGetValue("snapshot_json", out var json)) return null;

        try { return JsonSerializer.Deserialize<LibrarySnapshot>(json, JsonOptions); }
        catch (JsonException) { return null; }
    }


    public async Task<(int MusicCount, int CardCount, int CharacterCount, int ResourceCount, int DiagnosticCount)?> GetCountsAsync(
        GameInstallation installation, 
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(installation, cancellationToken);
        var command = connection.CreateCommand();
        command.CommandText = @"
            SELECT key, value FROM library_state 
            WHERE key IN ('cache_schema', 'game_root');";
        
        var state = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken)) 
            state[reader.GetString(0)] = reader.GetString(1);

        if (!state.TryGetValue("cache_schema", out var schema) || schema != CacheSchemaVersion
            || !state.TryGetValue("game_root", out var root)
            || !Path.GetFullPath(root).Equals(Path.GetFullPath(installation.RootPath), StringComparison.OrdinalIgnoreCase))
            return null;

        // 快速获取计数，不加载完整数据
        var countCmd = connection.CreateCommand();
        countCmd.CommandText = @"
            SELECT 
                (SELECT COUNT(*) FROM music) as music_count,
                (SELECT COUNT(*) FROM cards) as card_count,
                (SELECT COUNT(*) FROM characters) as character_count,
                (SELECT COUNT(*) FROM resources) as resource_count,
                (SELECT COUNT(*) FROM diagnostics WHERE severity = 2) as diagnostic_count;";
        
        await using var countReader = await countCmd.ExecuteReaderAsync(cancellationToken);
        if (!await countReader.ReadAsync(cancellationToken)) return null;
        
        return (
            countReader.GetInt32(0),
            countReader.GetInt32(1),
            countReader.GetInt32(2),
            countReader.GetInt32(3),
            countReader.GetInt32(4)
        );
    }

    public async Task<bool> IsSourceCurrentAsync(GameInstallation installation, CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(installation, cancellationToken);
        var command = connection.CreateCommand();
        command.CommandText = "SELECT value FROM library_state WHERE key = 'source_stamp' LIMIT 1;";
        var value = await command.ExecuteScalarAsync(cancellationToken);
        return value is string stamp && stamp == BuildSourceStamp(installation);
    }

    public async Task<bool> IsAmfsCurrentAsync(GameInstallation installation, CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(installation, cancellationToken);
        var command = connection.CreateCommand();
        command.CommandText = "SELECT key, value FROM library_state WHERE key IN ('cache_schema', 'game_root', 'amfs_stamp');";
        var state = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken)) state[reader.GetString(0)] = reader.GetString(1);

        if (!state.TryGetValue("cache_schema", out var schema) || schema != CacheSchemaVersion
            || !state.TryGetValue("game_root", out var root)
            || !Path.GetFullPath(root).Equals(Path.GetFullPath(installation.RootPath), StringComparison.OrdinalIgnoreCase))
            return false;

        return state.TryGetValue("amfs_stamp", out var stamp) && stamp == BuildIcfStamp(installation);
    }

    public async Task SaveAsync(LibrarySnapshot snapshot, CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(snapshot.Installation, cancellationToken);
        await using var transaction = (SqliteTransaction)await connection.BeginTransactionAsync(cancellationToken);
        foreach (var table in new[] { "music", "cards", "characters", "resources", "diagnostics" })
        {
            var clear = connection.CreateCommand();
            clear.Transaction = transaction;
            clear.CommandText = $"DELETE FROM {table};";
            await clear.ExecuteNonQueryAsync(cancellationToken);
        }

        foreach (var music in snapshot.EffectiveMusic)
            await InsertAsync(connection, transaction, "music",
                "logical_id,music_id,title,artist,genre,package_id,json",
                "$logical,$id,$title,$artist,$genre,$package,$json",
                [("$logical", music.Id.ToString()), ("$id", music.Id), ("$title", music.Title),
                 ("$artist", music.Artist), ("$genre", music.Genre), ("$package", music.Origin.PackageId),
                 ("$json", JsonSerializer.Serialize(music, JsonOptions))], cancellationToken);

        foreach (var card in snapshot.Cards)
            await InsertAsync(connection, transaction, "cards",
                "logical_id,card_id,name,character_id,character_name,rarity,attribute,package_id,json",
                "$logical,$id,$name,$characterId,$characterName,$rarity,$attribute,$package,$json",
                [("$logical", card.Id.ToString()), ("$id", card.Id), ("$name", card.Name),
                 ("$characterId", card.CharacterId), ("$characterName", card.CharacterName),
                 ("$rarity", card.Rarity), ("$attribute", card.Attribute),
                 ("$package", card.Origin.PackageId), ("$json", JsonSerializer.Serialize(card, JsonOptions))], cancellationToken);

        foreach (var character in snapshot.Characters)
            await InsertAsync(connection, transaction, "characters",
                "logical_id,character_id,name,model_id,package_id,json",
                "$logical,$id,$name,$model,$package,$json",
                [("$logical", character.Id.ToString()), ("$id", character.Id), ("$name", character.Name),
                 ("$model", character.ModelId), ("$package", character.Origin.PackageId),
                 ("$json", JsonSerializer.Serialize(character, JsonOptions))], cancellationToken);

        foreach (var resource in snapshot.Resources)
        {
            var logicalId = resource.Key + "\u001f" + resource.Origin.PackageId;
            await InsertAsync(connection, transaction, "resources",
                "logical_id,resource_key,kind,package_id,size,effective,json",
                "$logical,$key,$kind,$package,$size,$effective,$json",
                [("$logical", logicalId), ("$key", resource.Key), ("$kind", (int)resource.Kind),
                 ("$package", resource.Origin.PackageId), ("$size", resource.Size),
                 ("$effective", resource.Origin.IsEffective ? 1 : 0),
                 ("$json", JsonSerializer.Serialize(resource, JsonOptions))], cancellationToken);
        }

        var diagnosticIndex = 0;
        foreach (var diagnostic in snapshot.Diagnostics)
            await InsertAsync(connection, transaction, "diagnostics",
                "logical_id,severity,code,message,source,json",
                "$logical,$severity,$code,$message,$source,$json",
                [("$logical", (++diagnosticIndex).ToString()), ("$severity", (int)diagnostic.Severity),
                 ("$code", diagnostic.Code), ("$message", diagnostic.Message),
                 ("$source", diagnostic.SourcePath ?? string.Empty),
                 ("$json", JsonSerializer.Serialize(diagnostic, JsonOptions))], cancellationToken);

        var stateItems = new Dictionary<string, string>
        {
            ["last_scan_utc"] = DateTimeOffset.UtcNow.ToString("O"),
            ["cache_schema"] = CacheSchemaVersion,
            ["game_root"] = Path.GetFullPath(snapshot.Installation.RootPath),
            ["source_stamp"] = BuildSourceStamp(snapshot.Installation),
            ["amfs_stamp"] = BuildIcfStamp(snapshot.Installation),
            ["snapshot_json"] = JsonSerializer.Serialize(snapshot, JsonOptions)
        };
        foreach (var item in stateItems)
        {
            var state = connection.CreateCommand();
            state.Transaction = transaction;
            state.CommandText = "INSERT OR REPLACE INTO library_state VALUES ($key,$value);";
            state.Parameters.AddWithValue("$key", item.Key);
            state.Parameters.AddWithValue("$value", item.Value);
            await state.ExecuteNonQueryAsync(cancellationToken);
        }
        await transaction.CommitAsync(cancellationToken);
    }

    public Task<LibraryPage<Music>> QueryMusicAsync(GameInstallation installation, LibraryQuery query, CancellationToken cancellationToken) =>
        QueryAsync<Music>(installation, "music", query,
            ["title", "artist", "genre", "package_id"],
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            { ["genre"] = "genre", ["package"] = "package_id" },
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            { ["id"] = "music_id", ["title"] = "title COLLATE NOCASE", ["artist"] = "artist COLLATE NOCASE" },
            "music_id", cancellationToken);

    public Task<LibraryPage<Card>> QueryCardsAsync(GameInstallation installation, LibraryQuery query, CancellationToken cancellationToken) =>
        QueryAsync<Card>(installation, "cards", query,
            ["name", "character_name", "rarity", "attribute", "package_id"],
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            { ["character"] = "character_id", ["rarity"] = "rarity", ["attribute"] = "attribute", ["package"] = "package_id" },
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            { ["id"] = "card_id", ["name"] = "name COLLATE NOCASE", ["character"] = "character_name COLLATE NOCASE" },
            "card_id", cancellationToken);

    public Task<LibraryPage<Character>> QueryCharactersAsync(GameInstallation installation, LibraryQuery query, CancellationToken cancellationToken) =>
        QueryAsync<Character>(installation, "characters", query,
            ["name", "package_id"],
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["package"] = "package_id" },
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            { ["id"] = "character_id", ["name"] = "name COLLATE NOCASE", ["model"] = "model_id" },
            "character_id", cancellationToken);

    public Task<LibraryPage<GameResource>> QueryResourcesAsync(GameInstallation installation, LibraryQuery query, CancellationToken cancellationToken) =>
        QueryAsync<GameResource>(installation, "resources", query,
            ["resource_key", "package_id"],
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            { ["kind"] = "kind", ["package"] = "package_id", ["effective"] = "effective" },
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            { ["id"] = "resource_key COLLATE NOCASE", ["name"] = "resource_key COLLATE NOCASE", ["size"] = "size" },
            "resource_key COLLATE NOCASE", cancellationToken);

    public Task<LibraryPage<LibraryDiagnostic>> QueryDiagnosticsAsync(GameInstallation installation, LibraryQuery query, CancellationToken cancellationToken) =>
        QueryAsync<LibraryDiagnostic>(installation, "diagnostics", query,
            ["code", "message", "source"],
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            { ["severity"] = "severity", ["code"] = "code" },
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            { ["id"] = "CAST(logical_id AS INTEGER)", ["severity"] = "severity", ["code"] = "code COLLATE NOCASE" },
            "severity DESC, CAST(logical_id AS INTEGER)", cancellationToken);

    private async Task<LibraryPage<T>> QueryAsync<T>(
        GameInstallation installation,
        string table,
        LibraryQuery query,
        IReadOnlyList<string> searchColumns,
        IReadOnlyDictionary<string, string> filterColumns,
        IReadOnlyDictionary<string, string> sortColumns,
        string defaultSort,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(installation, cancellationToken);
        var clauses = new List<string>();
        var parameters = new List<(string Name, object Value)>();
        if (!string.IsNullOrWhiteSpace(query.Search))
        {
            clauses.Add("(" + string.Join(" OR ", searchColumns.Select(column => $"{column} LIKE $search ESCAPE '\\'")) + ")");
            parameters.Add(("$search", "%" + EscapeLike(query.Search.Trim()) + "%"));
        }
        foreach (var filter in query.EffectiveFilters)
        {
            if (!filterColumns.TryGetValue(filter.Key, out var column)) continue;
            var values = filter.Value.Where(value => !string.IsNullOrWhiteSpace(value)).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
            if (values.Length == 0) continue;
            var names = new List<string>(values.Length);
            for (var index = 0; index < values.Length; index++)
            {
                var name = $"$filter{parameters.Count}_{index}";
                names.Add(name);
                parameters.Add((name, values[index]));
            }
            clauses.Add($"CAST({column} AS TEXT) IN ({string.Join(',', names)})");
        }
        var where = clauses.Count == 0 ? string.Empty : " WHERE " + string.Join(" AND ", clauses);
        var sort = sortColumns.TryGetValue(query.Sort, out var selectedSort) ? selectedSort : defaultSort;
        var order = query.Descending ? " DESC" : " ASC";

        var count = connection.CreateCommand();
        count.CommandText = $"SELECT COUNT(*) FROM {table}{where};";
        AddParameters(count, parameters);
        var total = Convert.ToInt32(await count.ExecuteScalarAsync(cancellationToken));

        var command = connection.CreateCommand();
        command.CommandText = $"SELECT logical_id,json FROM {table}{where} ORDER BY {sort}{order}, logical_id ASC LIMIT $limit OFFSET $offset;";
        AddParameters(command, parameters);
        command.Parameters.AddWithValue("$limit", query.SafeLimit);
        command.Parameters.AddWithValue("$offset", query.SafeOffset);
        var items = new List<IndexedItem<T>>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            var value = JsonSerializer.Deserialize<T>(reader.GetString(1), JsonOptions);
            if (value is not null) items.Add(new(reader.GetString(0), value));
        }
        return new(items, total, query.SafeOffset, query.SafeLimit);
    }

    private async Task<SqliteConnection> OpenAsync(GameInstallation installation, CancellationToken cancellationToken)
    {
        var databasePath = _databasePathOverride ?? installation.IndexPath;
        Directory.CreateDirectory(Path.GetDirectoryName(databasePath)!);
        var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = databasePath,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Cache = SqliteCacheMode.Shared
        }.ToString());
        await connection.OpenAsync(cancellationToken);
        var command = connection.CreateCommand();
        command.CommandText = """
            PRAGMA journal_mode=WAL;
            PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS library_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS music (logical_id TEXT PRIMARY KEY, music_id INTEGER NOT NULL, title TEXT NOT NULL, artist TEXT NOT NULL, genre TEXT NOT NULL, package_id TEXT NOT NULL, json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS cards (logical_id TEXT PRIMARY KEY, card_id INTEGER NOT NULL, name TEXT NOT NULL, character_id INTEGER NOT NULL, character_name TEXT NOT NULL, rarity TEXT NOT NULL, attribute TEXT NOT NULL, package_id TEXT NOT NULL, json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS characters (logical_id TEXT PRIMARY KEY, character_id INTEGER NOT NULL, name TEXT NOT NULL, model_id INTEGER NOT NULL, package_id TEXT NOT NULL, json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS resources (logical_id TEXT PRIMARY KEY, resource_key TEXT NOT NULL, kind INTEGER NOT NULL, package_id TEXT NOT NULL, size INTEGER NOT NULL, effective INTEGER NOT NULL, json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS diagnostics (logical_id TEXT PRIMARY KEY, severity INTEGER NOT NULL, code TEXT NOT NULL, message TEXT NOT NULL, source TEXT NOT NULL, json TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS ix_music_title ON music(title);
            CREATE INDEX IF NOT EXISTS ix_cards_name ON cards(name);
            CREATE INDEX IF NOT EXISTS ix_characters_name ON characters(name);
            CREATE INDEX IF NOT EXISTS ix_resources_key ON resources(resource_key);
            CREATE INDEX IF NOT EXISTS ix_diagnostics_severity ON diagnostics(severity);
            """;
        await command.ExecuteNonQueryAsync(cancellationToken);
        return connection;
    }

    private static async Task InsertAsync(SqliteConnection connection, SqliteTransaction transaction,
        string table, string columns, string values, IReadOnlyList<(string Name, object Value)> parameters,
        CancellationToken cancellationToken)
    {
        var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"INSERT INTO {table} ({columns}) VALUES ({values});";
        AddParameters(command, parameters);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static void AddParameters(SqliteCommand command, IEnumerable<(string Name, object Value)> parameters)
    {
        foreach (var parameter in parameters) command.Parameters.AddWithValue(parameter.Name, parameter.Value);
    }

    private static string EscapeLike(string value) => value.Replace("\\", "\\\\", StringComparison.Ordinal)
        .Replace("%", "\\%", StringComparison.Ordinal).Replace("_", "\\_", StringComparison.Ordinal);

    private static string BuildSourceStamp(GameInstallation installation)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var root in new[] { installation.OptionPath, installation.AmfsPath })
        {
            AppendDirectoryStamp(hash, installation, root);
        }
        if (Directory.Exists(installation.GameDataPath))
        {
            foreach (var root in Directory.EnumerateDirectories(installation.GameDataPath)
                .Where(path => !Path.GetFileName(path).Equals("A000", StringComparison.OrdinalIgnoreCase))
                .OrderBy(path => path, StringComparer.OrdinalIgnoreCase))
            {
                AppendDirectoryStamp(hash, installation, root);
            }
        }
        return Convert.ToHexString(hash.GetHashAndReset());
    }

    private static string BuildDirectoryStamp(GameInstallation installation, string root)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        AppendDirectoryStamp(hash, installation, root);
        return Convert.ToHexString(hash.GetHashAndReset());
    }

    private static string BuildIcfStamp(GameInstallation installation)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        if (!Directory.Exists(installation.AmfsPath)) return Convert.ToHexString(hash.GetHashAndReset());

        foreach (var path in Directory.EnumerateFiles(installation.AmfsPath, "*", SearchOption.AllDirectories)
                     .Where(path => Path.GetFileName(path).StartsWith("icf", StringComparison.OrdinalIgnoreCase))
                     .OrderBy(path => path, StringComparer.OrdinalIgnoreCase))
        {
            var info = new FileInfo(path);
            Append(hash, Path.GetRelativePath(installation.AmfsPath, path));
            Append(hash, "\0" + info.Length + "\0" + info.LastWriteTimeUtc.Ticks + "\n");
            hash.AppendData(File.ReadAllBytes(path));
        }
        return Convert.ToHexString(hash.GetHashAndReset());
    }

    private static void AppendDirectoryStamp(IncrementalHash hash, GameInstallation installation, string root)
    {
        if (!Directory.Exists(root))
        {
            Append(hash, root + "\0missing");
            return;
        }
        foreach (var path in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories)
                     .OrderBy(path => path, StringComparer.OrdinalIgnoreCase))
        {
            var info = new FileInfo(path);
            Append(hash, Path.GetRelativePath(installation.RootPath, path));
            Append(hash, "\0" + info.Length + "\0" + info.LastWriteTimeUtc.Ticks + "\n");
        }
    }

    private static void Append(IncrementalHash hash, string value) =>
        hash.AppendData(Encoding.UTF8.GetBytes(value));
}
