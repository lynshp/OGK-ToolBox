using System;
using System.IO;
using System.Reflection;
using System.Collections.Generic;
using System.Text;
using System.Security.Cryptography;
using BepInEx;
using HarmonyLib;

// No game protocol assemblies are distributed or referenced. Network requests remain game-owned.
[BepInPlugin("com.ogk.toolbox.playercapture", "OGK Player Capture", "1.0.14")]
public sealed partial class PlayerCapture : BaseUnityPlugin
{
    private static readonly string[] Names = { "GetUserData", "GetUserMusic", "GetUserCard", "GetUserCharacter", "GetUserItem", "GetUserOption", "GetUserActivity", "GetUserRecentRating", "GetUserRatinglog" };
    private static readonly object Gate = new object();
    private static readonly Dictionary<object, Connection> Connections = new Dictionary<object, Connection>();
    private static readonly Dictionary<object, Connection> PreviewConnections = new Dictionary<object, Connection>();
    private static readonly Dictionary<object, UpsertObservation> UpsertObservations = new Dictionary<object, UpsertObservation>(new QueryReferenceComparer());
    private static readonly List<UpsertLifetime> UpsertLifetimes = new List<UpsertLifetime>();
    private static readonly List<UpsertClientWitness> UpsertClientWitnesses = new List<UpsertClientWitness>();
    private static UpsertClientWitness lastClientWitness;
    private static string lastUpsertReason = "none";
    private static int transportSendEntries, transportCompletedEntries, transportBoundSends, transportBoundCompletions, transportRetiredSends, transportRetiredCompletions;
    [ThreadStatic] private static object activeQuery;
    [ThreadStatic] private static object resetUpsertQuery;
    [ThreadStatic] private static bool resetContextActive;
    private static string session = Guid.NewGuid().ToString("N");
    private static string player = "";
    private static int sequence;
    private static string root;
    private static string machineSnapshot;
    private static string loginPlayer = "";
    private static string loginIdentity;
    private static string loginCard = "", loginClient = "", loginGeneration = Guid.NewGuid().ToString("N");
    private static bool loginSaveAccepted;
    private static string status = "initializing";
    private static DateTime nextHeartbeat;
    private Harmony harmony;
    private static bool machineHooks;
    private static bool previewHooks;
    private static int previewSequence;
    private static bool upsertHooks;
    private static int upsertSequence;
    private static int upsertRequestBytes;
    private static string gameRoot;
    private static string startupFingerprints;
    private static string backupFile;
    private static Type nativeBackup;
    private static MachineObservation pendingMachine;

    private sealed class MachineObservation
    {
        public string BoardId, Version, MachineName, UserName;
        public int OriginalCount, Count, Flags;
        public object Setting, SaveState;
        public IntPtr SavePointer;
        public bool Incremented;
        public DateTime Started;
    }

    private sealed class Connection { public string BaseUrl; public int Encryption; public string Agent; }
    private sealed class QueryReferenceComparer : IEqualityComparer<object>
    {
        public new bool Equals(object left, object right) { return Object.ReferenceEquals(left, right); }
        public int GetHashCode(object value) { return System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(value); }
    }
    private sealed class UpsertObservation
    {
        public object Request;
        public object UserAll;
        public int Region;
        public uint Place;
        public FieldInfo[] PayloadFields;
        public object[] PayloadValues;
        public bool PayloadSealed;
        public UpsertLifetime Lifetime;
        public string Player, Card, Client, Generation, Session, Identity, Machine, SerializedRequest, Agent;
        public Connection Connection;
        public DateTime Started;
        public int RequestBytes;
        public WeakReference TransportClient;
        public bool TransportRequestObserved, TransportCompression;
    }
    private sealed class UpsertLifetime
    {
        public WeakReference Query;
        public string Generation;
        public DateTime Started;
        public bool Retired;
    }
    private sealed class ResetContext { public object Previous; public bool PreviousActive, Active; }
    private sealed class UpsertClientWitness
    {
        public WeakReference Client;
        public DateTime RetiredAt;
        public string Generation, Reason;
        public bool SendEntered, CompletedEntered;
    }
    private void Awake()
    {
        try {
            // Unity 5's Mono exposes the .NET 2.0 API: only the two-argument overload exists.
            root = Path.Combine(Path.Combine(Path.Combine(Paths.GameRootPath, "Tools"), "OGKToolBox"), "player-data");
            // Keep the configuration used by this game run, even if the INI changes later.
            machineSnapshot = ReadMachineSnapshot(Path.Combine(Paths.GameRootPath, "segatools.ini"));
            WriteStatus("initializing");
            InitializeHooks();
            WriteStatus("ready");
        } catch (Exception ex) {
            try { if (harmony != null) harmony.UnpatchAll("com.ogk.toolbox.playercapture"); } catch { }
            WriteStatus("unsupported: " + ex.GetType().Name);
            Logger.LogWarning("Player capture initialization failed: " + ex.GetType().Name);
        }
    }
    private void InitializeHooks()
    {
            harmony = new Harmony("com.ogk.toolbox.playercapture");
            foreach (string name in Names) {
                Type type = AccessTools.TypeByName("MU3.Client." + name);
                MethodInfo method = type == null ? null : AccessTools.Method(type, "setResponse", new Type[] { typeof(string) });
                if ((method == null || method.ReturnType != typeof(bool)) && (name == "GetUserActivity" || name == "GetUserRecentRating" || name == "GetUserRatinglog")) continue;
                if (method == null || method.ReturnType != typeof(bool)) throw new InvalidOperationException("Unsupported game response type: " + name);
                harmony.Patch(method, postfix: new HarmonyMethod(typeof(PlayerCapture), "ReadResponse"));
            }
            Type packet = AccessTools.TypeByName("MU3.Client.Packet");
            harmony.Patch(AccessTools.Method(packet, "create"), prefix: new HarmonyMethod(typeof(PlayerCapture), "BeginPacket"), postfix: new HarmonyMethod(typeof(PlayerCapture), "EndPacket"));
            Type http = AccessTools.TypeByName("MU3.Client.NetHttpClient");
            // Packet.create calls the static factory, whose constructor does not call instance create.
            harmony.Patch(AccessTools.Method(http, "Create", new Type[] { typeof(uint), typeof(ushort), typeof(string), typeof(string), typeof(string), typeof(int), typeof(bool), typeof(int) }), prefix: new HarmonyMethod(typeof(PlayerCapture), "Connect"));
            Type login = AccessTools.TypeByName("MU3.Client.GameLogin");
            if (login != null) harmony.Patch(AccessTools.Method(login, "setResponse", new Type[] { typeof(string) }), postfix: new HarmonyMethod(typeof(PlayerCapture), "Login"));
            InitializePreviewHooks();
            InitializeUpsertHooks();
            InitializeMachineHooks();
            InitializeEditHooks();
    }
    private void InitializePreviewHooks()
    {
        // Diagnostics stay separate from normal save sessions and ownership.
        try {
            MethodInfo response = PreviewResponseMethod(AccessTools.TypeByName("MU3.Client.GetUserPreview"));
            MethodInfo agent = PreviewAgentMethod(AccessTools.TypeByName("MU3.Client.NetPacketUtil"));
            if (response == null || agent == null) throw new InvalidOperationException();
            harmony.Patch(response, postfix: new HarmonyMethod(typeof(PlayerCapture), "ReadPreviewResponse"));
            harmony.Patch(agent, postfix: new HarmonyMethod(typeof(PlayerCapture), "PreviewUserAgent"));
            previewHooks = true; WritePreviewStatus("waiting-for-preview");
        } catch { previewHooks = false; WritePreviewStatus("unavailable"); }
    }
    private static MethodInfo PreviewResponseMethod(Type type)
    {
        MethodInfo method = type == null ? null : AccessTools.Method(type, "setResponse", new Type[] { typeof(string) });
        return method != null && method.ReturnType == typeof(bool) ? method : null;
    }
    private static MethodInfo PreviewAgentMethod(Type type)
    {
        MethodInfo method = type == null ? null : AccessTools.Method(type, "getUserAgent");
        if (method == null || !method.IsStatic || method.ReturnType != typeof(string)) return null;
        ParameterInfo[] parameters = method.GetParameters();
        return parameters.Length == 1 && parameters[0].ParameterType.FullName == "MU3.Client.INetQuery" ? method : null;
    }
    private static bool IsCaptureReadName(string name)
    {
        return Array.IndexOf(Names, name) >= 0 || previewHooks && name == "GetUserPreview";
    }
    private void InitializeUpsertHooks()
    {
        // Observe the original serializer result and the original parsed response.
        // Optional write diagnostics never join ordinary capture or machine caches.
        try {
            Type type = AccessTools.TypeByName("MU3.Client.UpsertUserAll");
            MethodInfo request = UpsertRequestMethod(type), response = PreviewResponseMethod(type);
            MethodInfo agent = PreviewAgentMethod(AccessTools.TypeByName("MU3.Client.NetPacketUtil"));
            Type http = AccessTools.TypeByName("MU3.Client.NetHttpClient");
            MethodInfo factory = UpsertHttpFactoryMethod(http), send = UpsertHttpRequestMethod(http), completed = UpsertHttpCompletedMethod(http);
            MethodInfo reset = UpsertResetMethod(AccessTools.TypeByName("MU3.Client.Packet"));
            if (request == null || response == null || agent == null || factory == null || send == null || completed == null || reset == null) throw new InvalidOperationException();
            harmony.Patch(request, postfix: new HarmonyMethod(typeof(PlayerCapture), "ReadUpsertRequest"));
            harmony.Patch(response, postfix: new HarmonyMethod(typeof(PlayerCapture), "ReadUpsertResponse"));
            harmony.Patch(agent, postfix: new HarmonyMethod(typeof(PlayerCapture), "UpsertUserAgent"));
            harmony.Patch(factory, postfix: new HarmonyMethod(typeof(PlayerCapture), "CreatedUpsertClient"));
            harmony.Patch(send, prefix: new HarmonyMethod(typeof(PlayerCapture), "BeforeUpsertTransportRequest"));
            harmony.Patch(completed, postfix: new HarmonyMethod(typeof(PlayerCapture), "AfterUpsertTransportCompleted"));
            harmony.Patch(reset, prefix: new HarmonyMethod(typeof(PlayerCapture), "BeginUpsertReset"), postfix: new HarmonyMethod(typeof(PlayerCapture), "EndUpsertReset"), finalizer: new HarmonyMethod(typeof(PlayerCapture), "FinalizeUpsertReset"));
            upsertHooks = true; WriteUpsertStatus("waiting-for-login");
        } catch { upsertHooks = false; WriteUpsertStatus("unavailable"); }
    }
    private static MethodInfo UpsertRequestMethod(Type type)
    {
        MethodInfo method = type == null ? null : AccessTools.Method(type, "getRequest", Type.EmptyTypes);
        return method != null && !method.IsStatic && method.ReturnType == typeof(string) ? method : null;
    }
    private static MethodInfo UpsertHttpFactoryMethod(Type type)
    {
        MethodInfo method = type == null ? null : AccessTools.Method(type, "Create", new Type[] { typeof(uint), typeof(ushort), typeof(string), typeof(string), typeof(string), typeof(int), typeof(bool), typeof(int) });
        return method != null && method.IsStatic && method.ReturnType == type && !type.IsValueType ? method : null;
    }
    private static MethodInfo UpsertHttpRequestMethod(Type type)
    {
        MethodInfo method = type == null ? null : AccessTools.Method(type, "request", new Type[] { typeof(byte[]), typeof(string), typeof(bool) });
        return method != null && !method.IsStatic && method.ReturnType == typeof(bool) ? method : null;
    }
    private static MethodInfo UpsertHttpCompletedMethod(Type type)
    {
        MethodInfo method = type == null ? null : AccessTools.Method(type, "onCompleted", Type.EmptyTypes);
        if (method == null || method.IsStatic || method.ReturnType != typeof(void)) return null;
        foreach (string name in new string[] { "state_", "errorCode_", "httpStatusCode_", "responseLength_" }) {
            FieldInfo field = AccessTools.Field(type, name);
            if (field == null || field.FieldType != typeof(int) || field.IsStatic) return null;
        }
        FieldInfo response = AccessTools.Field(type, "response_");
        return response != null && response.FieldType == typeof(byte[]) && !response.IsStatic ? method : null;
    }
    private static MethodInfo UpsertResetMethod(Type type)
    {
        MethodInfo method = type == null ? null : AccessTools.Method(type, "reset", Type.EmptyTypes);
        return method != null && !method.IsStatic && method.ReturnType == typeof(bool) ? method : null;
    }
    private void InitializeMachineHooks()
    {
        // Optional observers are isolated from the core read-response hooks.
        // SaveRecord queues an asynchronous native write; its return value alone
        // never authorizes publication of the new counter.
        try {
            gameRoot = Path.GetFullPath(Paths.GameRootPath).TrimEnd('\\', '/');
            backupFile = ReadBackupFile(gameRoot);
            startupFingerprints = Fingerprints(gameRoot);
            nativeBackup = AccessTools.TypeByName("AMDaemon.Backup");
            Type packet = AccessTools.TypeByName("MU3.Client.PacketUpsertUserAll");
            Type setting = AccessTools.TypeByName("MU3.AM.BackupSettingExt");
            MethodInfo accepted = packet == null ? null : AccessTools.Method(packet, "clearFlags", Type.EmptyTypes);
            MethodInfo increment = setting == null ? null : AccessTools.Method(setting, "incSerialCount", Type.EmptyTypes);
            MethodInfo save = nativeBackup == null ? null : AccessTools.Method(nativeBackup, "SaveRecord", new Type[] { typeof(int) });
            if (startupFingerprints == null || backupFile == null || accepted == null || increment == null || save == null || save.ReturnType != typeof(bool)
                || AccessTools.Property(nativeBackup, "LastSaveState") == null || AccessTools.Property(nativeBackup, "IsBusy") == null
                || AccessTools.Method(setting, "getSerialCount", Type.EmptyTypes) == null || AccessTools.Method(setting, "getDirty", Type.EmptyTypes) == null) throw new InvalidOperationException();
            harmony.Patch(accepted, prefix: new HarmonyMethod(typeof(PlayerCapture), "BeforeAcceptedSave"));
            harmony.Patch(increment, postfix: new HarmonyMethod(typeof(PlayerCapture), "AfterSerialIncrement"));
            harmony.Patch(save, prefix: new HarmonyMethod(typeof(PlayerCapture), "BeforeNativeSave"), postfix: new HarmonyMethod(typeof(PlayerCapture), "AfterNativeSave"));
            machineHooks = true;
            WriteMachineStatus("waiting-for-game-save");
        } catch { machineHooks = false; WriteMachineStatus("unavailable"); }
    }
    private static object FieldValue(object value, string name)
    {
        if (value == null) throw new InvalidOperationException();
        FieldInfo field = AccessTools.Field(value.GetType(), name);
        if (field == null) throw new InvalidOperationException();
        return field.GetValue(value);
    }
    private static object PropertyValue(object value, string name)
    {
        if (value == null) throw new InvalidOperationException();
        PropertyInfo property = AccessTools.Property(value.GetType(), name);
        if (property == null) throw new InvalidOperationException();
        return property.GetValue(value, null);
    }
    private static bool MachineString(object value, int maximum)
    {
        string text = value as string;
        if (String.IsNullOrEmpty(text) || text.Length > maximum) return false;
        foreach (char c in text) if (c < 32) return false;
        return true;
    }
    private static MachineObservation ReadMachineObservation(object info)
    {
        object board = FieldValue(info, "boardId"), version = FieldValue(info, "version"), name = FieldValue(info, "machineName"), user = FieldValue(info, "userName");
        object count = FieldValue(info, "count"), flags = FieldValue(info, "flags");
        if (!MachineString(board, 64) || !MachineString(version, 512) || !MachineString(name, 256) || !MachineString(user, 256)
            || !(count is int) || (int)count < 0 || !(flags is int) || (int)flags < 0 || (int)flags > 15) throw new InvalidOperationException();
        return new MachineObservation { BoardId = (string)board, Version = (string)version, MachineName = (string)name, UserName = (string)user,
            OriginalCount = (int)count, Count = (int)count, Flags = (int)flags, Started = DateTime.UtcNow };
    }
    private static void BeforeAcceptedSave(object __instance)
    {
        try {
            if (!machineHooks || !Enabled()) return;
            lock (Gate) {
                pendingMachine = null;
                object query = FieldValue(__instance, "query_"), request = FieldValue(query, "request_");
                // Only this exact game-created object is observed. No card,
                // player identity, packet body or network destination is copied.
                pendingMachine = ReadMachineObservation(FieldValue(FieldValue(request, "upsertUserAll"), "clientSystemInfo"));
            }
        } catch { pendingMachine = null; WriteMachineStatus("unavailable"); }
    }
    private static void AfterSerialIncrement(object __instance)
    {
        try {
            if (!machineHooks) return;
            lock (Gate) {
                // An old cache must not survive a subsequent real game save.
                string file = Path.Combine(root, "machine-context.json");
                if (File.Exists(file)) File.Delete(file);
                if (pendingMachine == null || !Enabled()) return;
                object value = AccessTools.Method(__instance.GetType(), "getSerialCount", Type.EmptyTypes).Invoke(__instance, null);
                int expected = pendingMachine.OriginalCount == Int32.MaxValue ? 0 : pendingMachine.OriginalCount + 1;
                if (!(value is int) || (int)value != expected) { pendingMachine = null; WriteMachineStatus("unavailable"); return; }
                pendingMachine.Setting = __instance;
                pendingMachine.Count = (int)value;
                pendingMachine.Incremented = true;
                WriteMachineStatus("waiting-for-backup");
            }
        } catch { pendingMachine = null; WriteMachineStatus("unavailable"); }
    }
    private static void BeforeNativeSave() { TryObserveMachineFlush(); }
    private static void AfterNativeSave(int __0, bool __result)
    {
        try {
            if (!machineHooks || __0 != 3 || !__result) return;
            lock (Gate) {
                if (pendingMachine == null || !pendingMachine.Incremented || !Enabled()) return;
                object state = AccessTools.Property(nativeBackup, "LastSaveState").GetValue(null, null);
                object pointer = PropertyValue(state, "Pointer");
                if (!(pointer is IntPtr) || (IntPtr)pointer == IntPtr.Zero) throw new InvalidOperationException();
                pendingMachine.SaveState = state; pendingMachine.SavePointer = (IntPtr)pointer;
            }
        } catch { pendingMachine = null; WriteMachineStatus("unavailable"); }
    }
    private static void TryObserveMachineFlush()
    {
        try {
            if (!machineHooks) return;
            lock (Gate) {
                MachineObservation observation = pendingMachine;
                if (observation == null) return;
                if (!Enabled() || DateTime.UtcNow - observation.Started > TimeSpan.FromMinutes(2)) { pendingMachine = null; return; }
                if (observation.SaveState == null) return;
                // LastSaveState is a mutable reused wrapper. A different native
                // pointer cannot prove completion of the SettingExt request.
                if ((IntPtr)PropertyValue(observation.SaveState, "Pointer") != observation.SavePointer) { pendingMachine = null; WriteMachineStatus("unavailable"); return; }
                if (!(bool)PropertyValue(observation.SaveState, "IsDone")) return;
                if (!(bool)PropertyValue(observation.SaveState, "IsSucceeded")) { pendingMachine = null; WriteMachineStatus("unavailable"); return; }
                if ((bool)AccessTools.Property(nativeBackup, "IsBusy").GetValue(null, null)
                    || (bool)AccessTools.Method(observation.Setting.GetType(), "getDirty", Type.EmptyTypes).Invoke(observation.Setting, null)) return;
                object count = AccessTools.Method(observation.Setting.GetType(), "getSerialCount", Type.EmptyTypes).Invoke(observation.Setting, null);
                if (!(count is int) || (int)count != observation.Count) { pendingMachine = null; return; }
                PublishMachineObservation(observation);
                pendingMachine = null; // Never recreate a consumed cache from the same game save.
            }
        } catch { pendingMachine = null; WriteMachineStatus("unavailable"); }
    }
    private static void PublishMachineObservation(MachineObservation observation)
    {
        string fingerprints = Fingerprints(gameRoot);
        if (fingerprints == null || fingerprints != startupFingerprints || ReadBackupFile(gameRoot) != backupFile) throw new InvalidOperationException();
        string backup = FileDigest(backupFile, 8 * 1024 * 1024, true);
        if (backup == null || Fingerprints(gameRoot) != startupFingerprints) throw new InvalidOperationException();
        // Hashing shares the game's write handle. Recheck the same completed
        // native request and counter after IO, before publishing its observation.
        if ((IntPtr)PropertyValue(observation.SaveState, "Pointer") != observation.SavePointer
            || !(bool)PropertyValue(observation.SaveState, "IsDone") || !(bool)PropertyValue(observation.SaveState, "IsSucceeded")
            || (bool)AccessTools.Property(nativeBackup, "IsBusy").GetValue(null, null)
            || (bool)AccessTools.Method(observation.Setting.GetType(), "getDirty", Type.EmptyTypes).Invoke(observation.Setting, null)
            || (int)AccessTools.Method(observation.Setting.GetType(), "getSerialCount", Type.EmptyTypes).Invoke(observation.Setting, null) != observation.Count) throw new InvalidOperationException();
        string output = "{\"version\":1,\"source\":\"game-backup-flushed\",\"observedAt\":" + Quote(DateTime.UtcNow.ToString("o"))
            + ",\"fingerprints\":{" + fingerprints + ",\"backup\":" + Quote(backup) + "},\"clientSystemInfo\":{\"boardId\":" + Quote(observation.BoardId)
            + ",\"count\":" + observation.Count + ",\"flags\":" + observation.Flags + ",\"version\":" + Quote(observation.Version)
            + ",\"machineName\":" + Quote(observation.MachineName) + ",\"userName\":" + Quote(observation.UserName) + "}}";
        Directory.CreateDirectory(root);
        string target = Path.Combine(root, "machine-context.json"), temporary = target + ".tmp";
        File.WriteAllText(temporary, output, new UTF8Encoding(false));
        if (File.Exists(target)) File.Replace(temporary, target, null); else File.Move(temporary, target);
        WriteMachineStatus("available");
    }
    private static string FileDigest(string file, int maximum, bool exact)
    {
        try {
            FileInfo info = new FileInfo(file);
            if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0 || info.Length <= 0 || info.Length > maximum || exact && info.Length != maximum) return null;
            // amdaemon retains a writable backup handle after flushing. Sharing
            // it is necessary; two matching reads still require a stable file.
            using (SHA256 sha = SHA256.Create()) using (FileStream stream = File.Open(file, FileMode.Open, FileAccess.Read, exact ? FileShare.ReadWrite : FileShare.Read)) {
                string hash = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
                if (exact) {
                    stream.Position = 0;
                    string again = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
                    FileInfo after = new FileInfo(file);
                    if (hash != again || after.Length != info.Length || after.LastWriteTimeUtc != info.LastWriteTimeUtc) return null;
                }
                return hash;
            }
        } catch { return null; }
    }
    private static string Fingerprints(string directory)
    {
        string[] keys = { "assembly", "segatools", "mu3", "hook", "mono", "coreLibrary" };
        string[] files = { "mu3_Data/Managed/Assembly-CSharp.dll", "segatools.ini", "mu3.ini", "mu3hook.dll", "mu3_Data/Mono/mono.dll", "mu3_Data/Managed/mscorlib.dll" };
        string identity;
        using (SHA256 sha = SHA256.Create()) identity = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(directory).TrimEnd('\\', '/').ToLowerInvariant()))).Replace("-", "").ToLowerInvariant();
        string result = "\"root\":" + Quote(identity);
        for (int i = 0; i < keys.Length; i++) {
            string hash = FileDigest(Path.Combine(directory, files[i].Replace('/', Path.DirectorySeparatorChar)), 64 * 1024 * 1024, false);
            if (hash == null) return null;
            result += "," + Quote(keys[i]) + ":" + Quote(hash);
        }
        return result;
    }
    private static string ReadBackupFile(string directory)
    {
        try {
            string ini = Path.Combine(directory, "segatools.ini");
            if (!File.Exists(ini) || new FileInfo(ini).Length > 1024 * 1024) return null;
            string text;
            try { using (var reader = new StreamReader(ini, new UTF8Encoding(false, true), true)) text = reader.ReadToEnd(); }
            catch (DecoderFallbackException) { text = File.ReadAllText(ini, Encoding.GetEncoding(936)); }
            string section = "", appdata = null;
            using (var reader = new StringReader(text)) {
                string line;
                while ((line = reader.ReadLine()) != null) {
                    line = line.Trim().TrimStart('\uFEFF');
                    if (line.Length == 0 || line[0] == ';' || line[0] == '#') continue;
                    if (line[0] == '[' && line.IndexOf(']') > 0) { section = line.Substring(1, line.IndexOf(']') - 1).Trim(); continue; }
                    int equal = line.IndexOf('=');
                    if (equal < 1 || !String.Equals(section, "vfs", StringComparison.OrdinalIgnoreCase) || !String.Equals(line.Substring(0, equal).Trim(), "appdata", StringComparison.OrdinalIgnoreCase)) continue;
                    string value = line.Substring(equal + 1).Trim();
                    for (int i = 1; i < value.Length; i++) if ((value[i] == ';' || value[i] == '#') && Char.IsWhiteSpace(value[i - 1])) { value = value.Substring(0, i).TrimEnd(); break; }
                    if (value.Length >= 2 && value[0] == '"' && value[value.Length - 1] == '"') value = value.Substring(1, value.Length - 2);
                    if (!MachineString(value, 4096)) return null;
                    appdata = value;
                }
            }
            return appdata == null ? null : Path.Combine(Path.Combine(Path.GetFullPath(Path.Combine(directory, appdata)), "SDDT"), "appfile.dat");
        } catch { return null; }
    }
    private static void WriteMachineStatus(string value)
    {
        try { Directory.CreateDirectory(root); File.WriteAllText(Path.Combine(root, "machine-context-status.txt"), value, Encoding.UTF8); } catch { }
    }
    private static void WriteStatus(string value)
    {
        lock (Gate) {
            status = value;
            nextHeartbeat = DateTime.UtcNow.AddSeconds(5);
            try {
                Directory.CreateDirectory(root);
                File.WriteAllText(Path.Combine(root, "capture-session.txt"), session, new UTF8Encoding(false));
                File.WriteAllText(Path.Combine(root, "capture-status.txt"), value, Encoding.UTF8);
            } catch { /* Status reporting must not affect the game. */ }
        }
    }
    private void Update() { if (DateTime.UtcNow >= nextHeartbeat) { WriteStatus(status); if (upsertHooks) WriteUpsertDiagnostics(); } TryObserveMachineFlush(); }
    private static bool Enabled() { return File.Exists(Path.Combine(root, "capture.enabled")); }
    private static void BeginPacket(object __0) { activeQuery = __0; }
    private static void EndPacket() { activeQuery = null; }
    private static void Login(object __instance, bool __result)
    {
        lock (Gate) {
            // setResponse returning true only means parsing succeeded. Rejected logins
            // must clear the previous card rather than giving new reads its identity.
            session = Guid.NewGuid().ToString("N"); player = ""; sequence = 0;
            loginPlayer = ""; loginIdentity = null; Connections.Clear();
            loginCard = ""; loginClient = ""; loginGeneration = Guid.NewGuid().ToString("N");
            foreach (UpsertObservation observation in UpsertObservations.Values) if (observation.Lifetime != null) observation.Lifetime.Retired = true;
            UpsertObservations.Clear();
            upsertRequestBytes = 0;
            UpsertClientWitnesses.Clear(); lastClientWitness = null; lastUpsertReason = "none";
            loginSaveAccepted = false;
            if (upsertHooks) WriteUpsertStatus("waiting-for-login");
            try {
                if (!__result || !Enabled() || machineSnapshot == null) return;
                object response = AccessTools.Field(__instance.GetType(), "response_").GetValue(__instance);
                object resultValue = AccessTools.Field(response.GetType(), "returnCode").GetValue(response);
                int result = Convert.ToInt32(resultValue);
                if (result != 1 && result != 100) return;
                object request = AccessTools.Field(__instance.GetType(), "request_").GetValue(__instance);
                long id = Convert.ToInt64(AccessTools.Field(request.GetType(), "userId").GetValue(request));
                string code = Convert.ToString(AccessTools.Field(request.GetType(), "accessCode").GetValue(request));
                string client = Convert.ToString(AccessTools.Field(request.GetType(), "clientId").GetValue(request));
                if (id <= 0 || id > 9007199254740991L || !Digits(code, 20) || String.IsNullOrEmpty(client) || client.Length != 11) return;
                loginPlayer = id.ToString(System.Globalization.CultureInfo.InvariantCulture); player = loginPlayer;
                loginCard = code; loginClient = client;
                loginIdentity = "{\"version\":1,\"userId\":" + loginPlayer + ",\"accessCode\":" + Quote(code) + ",\"clientId\":" + Quote(client) + ",\"machine\":" + machineSnapshot + "}";
                loginSaveAccepted = resultValue is int && (int)resultValue == 1;
                WriteStatus("ready");
                if (upsertHooks && loginSaveAccepted) WriteUpsertStatus("waiting-for-upsert");
            } catch { /* Unsupported login metadata leaves this session unassigned. */ }
        }
    }
    private static void Connect(object[] __args)
    {
        bool upsert = false;
        try {
            if (!Enabled() || activeQuery == null) return;
            upsert = upsertHooks && activeQuery.GetType().FullName == "MU3.Client.UpsertUserAll";
            if (!upsert && !IsCaptureReadName(activeQuery.GetType().Name)) return;
            string api = activeQuery.GetType().Name + "Api", requestPath = (string)__args[4];
            string authority = (string)__args[3];
            string baseUrl = ((bool)__args[6] ? "https://" : "http://") + authority + requestPath;
            int encryption = (int)__args[5];
            if (requestPath.EndsWith(api, StringComparison.Ordinal)) baseUrl = baseUrl.Substring(0, baseUrl.Length - api.Length);
            else encryption = Math.Max(1, encryption);
            string agent = null;
            // Preview observes the game's later send-path calculation instead
            // of manufacturing a fresh calculation while creating the client.
            if (!upsert && activeQuery.GetType().Name != "GetUserPreview") {
                var utility = AccessTools.TypeByName("MU3.Client.NetPacketUtil");
                agent = (string)AccessTools.Method(utility, "getUserAgent").Invoke(null, new object[] { activeQuery });
            }
            lock (Gate) {
                if (upsert) {
                    RememberUpsertQuery(activeQuery, new Connection { BaseUrl = baseUrl, Encryption = encryption, Agent = null });
                    return;
                }
                if (activeQuery.GetType().Name == "GetUserPreview") {
                    if (PreviewConnections.Count > 1000) PreviewConnections.Clear();
                    PreviewConnections[activeQuery] = new Connection { BaseUrl = baseUrl, Encryption = encryption, Agent = null };
                    return;
                }
                if (Connections.Count > 1000) Connections.Clear();
                Connections[activeQuery] = new Connection { BaseUrl = baseUrl, Encryption = encryption, Agent = agent };
            }
        } catch { if (upsert) RejectUpsertQuery(activeQuery, "connection-metadata-unavailable", "unavailable"); /* A capture failure must never affect the game request. */ }
    }
    private static void PreviewUserAgent(object __0, string __result)
    {
        try {
            if (!previewHooks || !Enabled() || __0 == null || __0.GetType().Name != "GetUserPreview" || !MachineString(__result, 512)) return;
            lock (Gate) {
                Connection connection;
                if (PreviewConnections.TryGetValue(__0, out connection)) connection.Agent = __result;
            }
        } catch { WritePreviewStatus("unavailable"); }
    }
    private static string PreviewPlayer(object request, object response)
    {
        try {
            object requestId = FieldValue(request, "userId"), responseId = FieldValue(response, "userId");
            if (!(requestId is uint || requestId is ulong || requestId is int || requestId is long)
                || !(responseId is uint || responseId is ulong || responseId is int || responseId is long)) return null;
            long id = Convert.ToInt64(requestId);
            if (id <= 0 || id > 9007199254740991L || Convert.ToInt64(responseId) != id
                || !(FieldValue(response, "isLogin") is bool) || !(FieldValue(response, "isWarningConfirmed") is bool)
                || !(FieldValue(response, "banStatus") is int)) return null;
            return id.ToString(System.Globalization.CultureInfo.InvariantCulture);
        } catch { return null; }
    }
    private static void ReadPreviewResponse(object __instance, string __0, bool __result)
    {
        try {
            if (!previewHooks || !__result || !Enabled() || String.IsNullOrEmpty(__0) || __0.Length > 8 * 1024 * 1024) return;
            object request = FieldValue(__instance, "request_"), response = FieldValue(__instance, "response_");
            string id = PreviewPlayer(request, response);
            if (id == null) return;
            Type json = AccessTools.TypeByName("UnityEngine.JsonUtility");
            string requestJson = (string)AccessTools.Method(json, "ToJson", new Type[] { typeof(object) }).Invoke(null, new object[] { request });
            lock (Gate) {
                Connection connection;
                PreviewConnections.TryGetValue(__instance, out connection); PreviewConnections.Remove(__instance);
                WritePreviewObservation(true, id, requestJson, __0, connection);
            }
        } catch { WritePreviewStatus("unavailable"); }
    }
    private static void WritePreviewObservation(bool parsed, string id, string requestJson, string responseJson, Connection connection)
    {
        try {
            lock (Gate) {
                long playerId;
                if (!parsed || !previewHooks || !Enabled() || previewSequence >= 128 || !Int64.TryParse(id, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out playerId)
                    || playerId <= 0 || playerId > 9007199254740991L || String.IsNullOrEmpty(requestJson) || Encoding.UTF8.GetByteCount(requestJson) > 1024 * 1024
                    || String.IsNullOrEmpty(responseJson) || Encoding.UTF8.GetByteCount(responseJson) > 8 * 1024 * 1024 || connection == null
                    || !MachineString(connection.BaseUrl, 4096) || !MachineString(connection.Agent, 512) || connection.Encryption < 0) return;
                string output = "{\"version\":1,\"api\":\"GetUserPreviewApi\",\"at\":" + Quote(DateTime.UtcNow.ToString("o"))
                    + ",\"request\":" + requestJson + ",\"response\":" + responseJson + ",\"connection\":{\"baseUrl\":" + Quote(connection.BaseUrl)
                    + ",\"encryptVersion\":" + connection.Encryption + ",\"userAgent\":" + Quote(connection.Agent) + "},\"machine\":" + (machineSnapshot ?? "null") + "}";
                string directory = Path.Combine(root, "preview-observations"); Directory.CreateDirectory(directory);
                string target = Path.Combine(directory, Guid.NewGuid().ToString("N") + ".json");
                File.WriteAllText(target + ".tmp", output, new UTF8Encoding(false)); File.Move(target + ".tmp", target);
                previewSequence++; WritePreviewStatus("captured");
            }
        } catch { WritePreviewStatus("unavailable"); }
    }
    private static void WritePreviewStatus(string value)
    {
        try { Directory.CreateDirectory(root); File.WriteAllText(Path.Combine(root, "preview-capture-status.txt"), value, Encoding.UTF8); } catch { }
    }
    // Only selected fixed top-level fields are retained. No game JSON parser,
    // serializer, getter, network method or native state machine is invoked.
    private sealed partial class ObservedJson
    {
        private readonly string text;
        private int index;
        public string ReturnCode, UserId, Card, Client, Region, Place;
        public bool NumericCode, NumericUser, NumericRegion, NumericPlace, HasPayload, HasUser;
        public ObservedJson(string value) { text = value; }
        private void Space() { while (index < text.Length && (text[index] == ' ' || text[index] == '\t' || text[index] == '\r' || text[index] == '\n')) index++; }
        private bool Take(char value) { Space(); if (index >= text.Length || text[index] != value) return false; index++; return true; }
        private string String(bool retain)
        {
            if (!Take('"')) throw new FormatException();
            StringBuilder result = retain ? new StringBuilder() : null;
            while (index < text.Length) {
                char value = text[index++];
                if (value == '"') return result == null ? null : result.ToString();
                if (value < 32) throw new FormatException();
                if (value == '\\') {
                    if (index >= text.Length) throw new FormatException();
                    value = text[index++];
                    if (value == 'u') {
                        int code = 0;
                        for (int i = 0; i < 4; i++) {
                            if (index >= text.Length) throw new FormatException();
                            char digit = text[index++];
                            int number = digit >= '0' && digit <= '9' ? digit - '0' : digit >= 'a' && digit <= 'f' ? digit - 'a' + 10 : digit >= 'A' && digit <= 'F' ? digit - 'A' + 10 : -1;
                            if (number < 0) throw new FormatException(); code = (code << 4) | number;
                        }
                        value = (char)code;
                    } else if (value == 'b') value = '\b';
                    else if (value == 'f') value = '\f';
                    else if (value == 'n') value = '\n';
                    else if (value == 'r') value = '\r';
                    else if (value == 't') value = '\t';
                    else if (value != '"' && value != '\\' && value != '/') throw new FormatException();
                }
                if (result != null) { if (result.Length >= 4096) throw new FormatException(); result.Append(value); }
            }
            throw new FormatException();
        }
        private void Literal(string value)
        {
            if (index + value.Length > text.Length || System.String.CompareOrdinal(text, index, value, 0, value.Length) != 0) throw new FormatException();
            index += value.Length;
        }
        private string Number()
        {
            int start = index;
            if (text[index] == '-') index++;
            if (index >= text.Length) throw new FormatException();
            if (text[index] == '0') index++;
            else { if (text[index] < '1' || text[index] > '9') throw new FormatException(); while (index < text.Length && text[index] >= '0' && text[index] <= '9') index++; }
            if (index < text.Length && text[index] == '.') {
                index++; int first = index;
                while (index < text.Length && text[index] >= '0' && text[index] <= '9') index++;
                if (first == index) throw new FormatException();
            }
            if (index < text.Length && (text[index] == 'e' || text[index] == 'E')) {
                index++; if (index < text.Length && (text[index] == '+' || text[index] == '-')) index++;
                int first = index;
                while (index < text.Length && text[index] >= '0' && text[index] <= '9') index++;
                if (first == index) throw new FormatException();
            }
            if (index - start > 128) throw new FormatException();
            return text.Substring(start, index - start);
        }
        private char Value(int depth, bool retain, out string value)
        {
            value = null; Space();
            if (depth > 64 || index >= text.Length) throw new FormatException();
            char next = text[index];
            if (next == '"') { value = String(retain); return 's'; }
            if (next == '-' || next >= '0' && next <= '9') { string number = Number(); if (retain) value = number; return 'd'; }
            if (next == 't') { Literal("true"); return 'b'; }
            if (next == 'f') { Literal("false"); return 'b'; }
            if (next == 'n') { Literal("null"); return 'n'; }
            if (next == '{' || next == '[') {
                index++; char close = next == '{' ? '}' : ']';
                if (Take(close)) return next == '{' ? 'o' : 'a';
                do {
                    if (next == '{') { String(false); if (!Take(':')) throw new FormatException(); }
                    string ignored; Value(depth + 1, false, out ignored);
                    if (Take(close)) return next == '{' ? 'o' : 'a';
                } while (Take(','));
            }
            throw new FormatException();
        }
        public bool Parse()
        {
            try {
                if (!Take('{')) return false;
                Dictionary<string, bool> keys = new Dictionary<string, bool>(StringComparer.Ordinal);
                if (!Take('}')) {
                    do {
                        string key = String(true);
                        if (keys.Count >= 256 || keys.ContainsKey(key) || !Take(':')) return false;
                        keys.Add(key, true);
                        bool selected = key == "returnCode" || key == "userId" || key == "accessCode" || key == "clientId" || key == "regionId" || key == "placeId";
                        string value; char type = Value(1, selected, out value);
                        if (key == "returnCode") { ReturnCode = value; NumericCode = type == 'd'; }
                        else if (key == "userId") { UserId = value; NumericUser = type == 'd'; HasUser = true; }
                        else if (key == "accessCode") Card = type == 's' ? value : null;
                        else if (key == "clientId") Client = type == 's' ? value : null;
                        else if (key == "regionId") { Region = value; NumericRegion = type == 'd'; }
                        else if (key == "placeId") { Place = value; NumericPlace = type == 'd'; }
                        else if (key == "upsertUserAll") HasPayload = type == 'o';
                        if (Take('}')) { Space(); return index == text.Length; }
                    } while (Take(','));
                    return false;
                }
                Space(); return index == text.Length;
            } catch { return false; }
        }
    }
    private static void BeginUpsertReset(object __instance, out object __state)
    {
        ResetContext context = new ResetContext { Previous = resetUpsertQuery, PreviousActive = resetContextActive, Active = true };
        __state = context; resetUpsertQuery = null; resetContextActive = true;
        try {
            object query = FieldValue(__instance, "query_");
            if (upsertHooks && Enabled() && query != null && query.GetType().FullName == "MU3.Client.UpsertUserAll"
                && UpsertOwnerMatches(FieldValue(query, "request_"), null)) resetUpsertQuery = query;
        } catch { /* Restoration is independent of optional ownership. */ }
    }
    private static void EndUpsertReset(object __state)
    {
        ResetContext context = __state as ResetContext;
        if (context == null || !context.Active) return;
        resetUpsertQuery = context.Previous; resetContextActive = context.PreviousActive; context.Active = false;
    }
    private static Exception FinalizeUpsertReset(Exception __exception, object __state) { EndUpsertReset(__state); return __exception; }
    private static Connection UpsertFactoryConnection(object[] args)
    {
        if (args == null || args.Length != 8 || !(args[3] is string) || !(args[4] is string) || !(args[5] is int) || !(args[6] is bool)) throw new InvalidOperationException();
        string api = "UpsertUserAllApi", path = (string)args[4];
        string url = ((bool)args[6] ? "https://" : "http://") + (string)args[3] + path;
        int encryption = (int)args[5];
        if (path.EndsWith(api, StringComparison.Ordinal)) url = url.Substring(0, url.Length - api.Length);
        else encryption = Math.Max(1, encryption);
        if (!MachineString(url, 4096) || encryption < 0) throw new InvalidOperationException();
        return new Connection { BaseUrl = url, Encryption = encryption };
    }
    private static void CreatedUpsertClient(object __result, object[] __args)
    {
        try {
            lock (Gate) {
                object query = resetContextActive ? resetUpsertQuery : activeQuery;
                if (!upsertHooks || !Enabled() || query == null || query.GetType().FullName != "MU3.Client.UpsertUserAll") return;
                if (__result == null || __result.GetType().FullName != "MU3.Client.NetHttpClient") { RejectUpsertQuery(query, "transport-client-invalid", "transport-client-invalid"); return; }
                RememberUpsertQuery(query, UpsertFactoryConnection(__args));
                UpsertObservation observation;
                if (!UpsertObservations.TryGetValue(query, out observation)) return;
                string failure = UpsertOwnerFailure(FieldValue(query, "request_"), observation);
                if (failure != null) { RejectUpsertQuery(query, failure, "transport-owner-mismatch"); return; }
                foreach (KeyValuePair<object, UpsertObservation> pair in UpsertObservations) {
                    if (!Object.ReferenceEquals(pair.Key, query) && pair.Value.TransportClient != null && Object.ReferenceEquals(pair.Value.TransportClient.Target, __result)) {
                        RejectUpsertQuery(query, "transport-client-mismatch", "transport-client-mismatch"); return;
                    }
                }
                object previous = observation.TransportClient == null ? null : observation.TransportClient.Target;
                if (observation.TransportClient != null && !Object.ReferenceEquals(previous, __result) && !(resetContextActive && Object.ReferenceEquals(resetUpsertQuery, query))) {
                    RejectUpsertQuery(query, "transport-client-replaced", "transport-client-replaced"); return;
                }
                if (observation.TransportClient != null && !Object.ReferenceEquals(previous, __result)) {
                    upsertRequestBytes = Math.Max(0, upsertRequestBytes - observation.RequestBytes);
                    observation.RequestBytes = 0; observation.SerializedRequest = null; observation.Agent = null; observation.TransportRequestObserved = false;
                }
                observation.TransportClient = new WeakReference(__result);
                WriteUpsertStatus("transport-client-observed");
            }
        } catch { object query = resetContextActive ? resetUpsertQuery : activeQuery; if (query != null && query.GetType().FullName == "MU3.Client.UpsertUserAll") RejectUpsertQuery(query, "transport-factory-unavailable", "transport-unavailable"); }
    }
    private static object UpsertQueryForClient(object client)
    {
        if (client == null || client.GetType().FullName != "MU3.Client.NetHttpClient") return null;
        foreach (KeyValuePair<object, UpsertObservation> pair in UpsertObservations)
            if (pair.Value.TransportClient != null && Object.ReferenceEquals(pair.Value.TransportClient.Target, client)) return pair.Key;
        return null;
    }
    private static string DecodeObservedBytes(byte[] bytes, int length, int maximum)
    {
        if (bytes == null || length <= 0 || length > maximum || length > bytes.Length) throw new FormatException();
        byte[] copy = new byte[length]; Buffer.BlockCopy(bytes, 0, copy, 0, length);
        return new UTF8Encoding(false, true).GetString(copy, 0, length);
    }
    private static void BeforeUpsertTransportRequest(object __instance, byte[] __0, string __1, bool __2)
    {
        object query = null;
        try {
            lock (Gate) {
                IncrementWitnessCounter(ref transportSendEntries);
                query = UpsertQueryForClient(__instance);
                if (query == null) { ObserveRetiredUpsertClient(__instance, false); return; }
                IncrementWitnessCounter(ref transportBoundSends);
                UpsertObservation observation = UpsertObservations[query];
                string failure = !upsertHooks ? "hooks-unavailable" : !Enabled() ? "capture-disabled" : UpsertOwnerFailure(FieldValue(query, "request_"), observation);
                if (failure != null) { RejectUpsertQuery(query, failure, "transport-owner-or-lifetime-mismatch"); return; }
                if (__0 == null || __0.Length == 0) { RejectUpsertQuery(query, "transport-request-empty", "transport-request-limit"); return; }
                if (__0.Length > 8 * 1024 * 1024) { RejectUpsertQuery(query, "transport-request-byte-limit", "transport-request-limit"); return; }
                if (!MachineString(__1, 512)) { RejectUpsertQuery(query, "transport-agent-invalid", "transport-request-limit"); return; }
                if (upsertRequestBytes - observation.RequestBytes + __0.Length > 16 * 1024 * 1024) { RejectUpsertQuery(query, "transport-request-budget", "transport-request-limit"); return; }
                string original = DecodeObservedBytes(__0, __0.Length, 8 * 1024 * 1024);
                failure = ObservedUpsertRequestFailure(original, observation, "transport");
                if (failure != null) { RejectUpsertQuery(query, failure, "transport-request-invalid"); return; }
                failure = SealUpsertPayload(FieldValue(query, "request_"), observation);
                if (failure != null) { RejectUpsertQuery(query, failure, "transport-owner-or-lifetime-mismatch"); return; }
                upsertRequestBytes = upsertRequestBytes - observation.RequestBytes + __0.Length;
                observation.RequestBytes = __0.Length; observation.SerializedRequest = original;
                observation.Agent = __1; observation.TransportRequestObserved = true; observation.TransportCompression = __2;
                WriteUpsertStatus("transport-waiting-for-response");
            }
        } catch { if (query != null) RejectUpsertQuery(query, "transport-request-decode-or-metadata-invalid", "transport-request-invalid"); }
    }
    private static void AfterUpsertTransportCompleted(object __instance)
    {
        object query = null;
        try {
            lock (Gate) {
                IncrementWitnessCounter(ref transportCompletedEntries);
                query = UpsertQueryForClient(__instance);
                if (query == null) { ObserveRetiredUpsertClient(__instance, true); return; }
                IncrementWitnessCounter(ref transportBoundCompletions);
                UpsertObservation observation = UpsertObservations[query];
                string failure = !upsertHooks ? "hooks-unavailable" : !Enabled() ? "capture-disabled" : UpsertOwnerFailure(FieldValue(query, "request_"), observation);
                if (failure != null) { RejectUpsertQuery(query, failure, "transport-owner-or-lifetime-mismatch"); return; }
                object state = FieldValue(__instance, "state_"), error = FieldValue(__instance, "errorCode_"), statusCode = FieldValue(__instance, "httpStatusCode_");
                failure = !(state is int) ? "transport-state-type" : (int)state != 3 ? "transport-state-not-finished"
                    : !(error is int) ? "transport-error-type" : (int)error != 0 ? "transport-native-error"
                    : !(statusCode is int) ? "transport-http-type" : (int)statusCode < 200 || (int)statusCode >= 300 ? "transport-http-status" : null;
                if (failure != null) { RejectUpsertQuery(query, failure, "transport-http-not-successful"); return; }
                if (!observation.PayloadSealed || !observation.TransportRequestObserved || String.IsNullOrEmpty(observation.SerializedRequest) || !MachineString(observation.Agent, 512) || observation.Connection == null) {
                    RejectUpsertQuery(query, "transport-context-incomplete", "transport-context-incomplete"); return;
                }
                object length = FieldValue(__instance, "responseLength_");
                byte[] responseBytes = FieldValue(__instance, "response_") as byte[];
                failure = !(length is int) ? "transport-response-length-type" : responseBytes == null || (int)length <= 0 ? "transport-response-empty"
                    : (int)length > 1024 * 1024 ? "transport-response-byte-limit" : (int)length > responseBytes.Length ? "transport-response-length-invalid" : null;
                if (failure != null) { RejectUpsertQuery(query, failure, "transport-response-invalid"); return; }
                string response = DecodeObservedBytes(responseBytes, (int)length, 1024 * 1024);
                ObservedJson parsed = new ObservedJson(response);
                if (!parsed.Parse()) { RejectUpsertQuery(query, "transport-response-json-invalid", "transport-response-invalid"); return; }
                if (!parsed.NumericCode || parsed.ReturnCode != "1") { RejectUpsertQuery(query, "transport-response-code-not-one", "transport-response-not-confirmed"); return; }
                if (parsed.HasUser && (!parsed.NumericUser || parsed.UserId != observation.Player)) { RejectUpsertQuery(query, "transport-response-owner", "transport-response-owner-mismatch"); return; }
                PublishUpsertObservation(query, observation, response, "game-transport-success-response", "net-http-request-completed", "transport-success-return-code");
            }
        } catch { if (query != null) RejectUpsertQuery(query, "transport-response-decode-or-metadata-invalid", "transport-response-invalid"); }
    }
    private static bool UpsertOwnerMatches(object request, UpsertObservation observation)
    {
        return UpsertOwnerFailure(request, observation) == null;
    }
    private static string UpsertOwnerFailure(object request, UpsertObservation observation)
    {
        try {
            if (!loginSaveAccepted) return "login-not-accepted";
            if (request == null) return "request-missing";
            if (String.IsNullOrEmpty(loginIdentity) || String.IsNullOrEmpty(machineSnapshot)) return "source-unavailable";
            object value = FieldValue(request, "userId");
            if (!(value is uint || value is ulong || value is int || value is long)) return "owner-user-type";
            long id = Convert.ToInt64(value);
            string card = FieldValue(request, "accessCode") as string, client = FieldValue(request, "clientId") as string;
            string idText = id.ToString(System.Globalization.CultureInfo.InvariantCulture);
            if (id <= 0 || id > 9007199254740991L || idText != loginPlayer) return "owner-user";
            if (!Digits(card, 20) || card != loginCard) return "owner-card";
            if (String.IsNullOrEmpty(client) || client.Length != 11 || client != loginClient) return "owner-client";
            string requestFailure = UpsertRequestFailure(request, observation);
            if (requestFailure != null || observation == null) return requestFailure;
            if (observation.Player != loginPlayer || observation.Card != loginCard || observation.Client != loginClient) return "source-owner";
            if (observation.Generation != loginGeneration) return "source-generation";
            if (observation.Identity != loginIdentity) return "source-identity";
            if (observation.Machine != machineSnapshot) return "source-machine";
            if (observation.Lifetime == null) return "lifetime-missing";
            if (observation.Generation != observation.Lifetime.Generation || observation.Started != observation.Lifetime.Started) return "lifetime-context";
            if (DateTime.UtcNow - observation.Started > TimeSpan.FromMinutes(2)) return "lifetime-expired";
            return null;
        } catch { return "request-metadata-unavailable"; }
    }
    private static bool UpsertRequestMatches(object request, UpsertObservation observation)
    {
        return UpsertRequestFailure(request, observation) == null;
    }
    private static string UpsertRequestFailure(object request, UpsertObservation observation)
    {
        Type requestType = request.GetType();
        if (!requestType.IsValueType) return observation == null || Object.ReferenceEquals(request, observation.Request) ? null : "request-reference";
        // Native UpsertUserAllRequest is a struct: each FieldInfo.GetValue
        // boxes it anew. Bind its stable context and class payload instead of
        // comparing box references. serialize() legitimately changes nonce_.
        if (requestType.FullName != "MU3.Client.UpsertUserAllRequest" || !(FieldValue(request, "nonce_") is int)
            || !(FieldValue(request, "userId") is long) || !(FieldValue(request, "regionId") is int)
            || !(FieldValue(request, "placeId") is uint)) return "request-native-type";
        object payload = FieldValue(request, "upsertUserAll");
        if (payload == null || payload.GetType().IsValueType || payload.GetType().FullName != "MU3.Client.UserAll") return "request-payload-type";
        FieldInfo[] fields = payload.GetType().GetFields(BindingFlags.Public | BindingFlags.Instance);
        if (fields.Length == 0 || fields.Length > 128) return "request-payload-shape";
        if (observation == null) return null;
        if (observation.Request == null || requestType != observation.Request.GetType()) return "request-native-type";
        if (!Object.ReferenceEquals(payload, observation.UserAll)) return "request-payload-reference";
        if ((int)FieldValue(request, "regionId") != observation.Region) return "request-region";
        if ((uint)FieldValue(request, "placeId") != observation.Place) return "request-place";
        // Factory binds the exact native object and owner immediately. Its
        // field snapshot is sealed once, only after original request evidence
        // has passed JSON and size validation. Agent observation never seals.
        if (!observation.PayloadSealed) return null;
        if (observation.PayloadFields == null || observation.PayloadValues == null || fields.Length != observation.PayloadFields.Length
            || fields.Length != observation.PayloadValues.Length) return "request-payload-shape";
        for (int i = 0; i < observation.PayloadFields.Length; i++) {
            FieldInfo field = observation.PayloadFields[i];
            object value = field.GetValue(payload), original = observation.PayloadValues[i];
            // Freeze top-level lists/objects and immutable marker values.
            // The original serialized string is retained separately; this
            // guard does not reserialize or claim to freeze nested elements.
            if (field.FieldType.IsValueType || field.FieldType == typeof(string)) {
                if (!Object.Equals(value, original)) return "request-payload-marker";
            } else if (!Object.ReferenceEquals(value, original)) return "request-payload-field-reference";
        }
        return null;
    }
    private static string ObservedUpsertRequestFailure(string original, UpsertObservation observation, string path)
    {
        ObservedJson parsed = new ObservedJson(original);
        return !parsed.Parse() ? path + "-request-json-invalid" : !parsed.NumericUser || parsed.UserId != observation.Player ? path + "-request-owner-user"
            : parsed.Card != observation.Card ? path + "-request-owner-card" : parsed.Client != observation.Client ? path + "-request-owner-client"
            : !parsed.HasPayload ? path + "-request-payload-missing"
            : observation.UserAll != null && (!parsed.NumericRegion || parsed.Region != observation.Region.ToString(System.Globalization.CultureInfo.InvariantCulture)) ? path + "-request-region"
            : observation.UserAll != null && (!parsed.NumericPlace || parsed.Place != observation.Place.ToString(System.Globalization.CultureInfo.InvariantCulture)) ? path + "-request-place" : null;
    }
    private static string SealUpsertPayload(object request, UpsertObservation observation)
    {
        string failure = UpsertOwnerFailure(request, observation);
        if (failure != null || observation.PayloadSealed) return failure;
        if (observation.UserAll != null) {
            FieldInfo[] fields = observation.UserAll.GetType().GetFields(BindingFlags.Public | BindingFlags.Instance);
            if (fields.Length == 0 || fields.Length > 128) return "request-payload-shape";
            object[] values = new object[fields.Length];
            for (int i = 0; i < fields.Length; i++) values[i] = fields[i].GetValue(observation.UserAll);
            observation.PayloadFields = fields; observation.PayloadValues = values;
        }
        observation.PayloadSealed = true;
        return null;
    }
    private static void RememberUpsertQuery(object query, Connection connection)
    {
        try {
            lock (Gate) {
                if (!upsertHooks || !Enabled() || query == null || query.GetType().FullName != "MU3.Client.UpsertUserAll") return;
                foreach (UpsertLifetime prior in UpsertLifetimes)
                    if (Object.ReferenceEquals(prior.Query.Target, query) && prior.Retired) return; // Preserve the first retirement reason across late callbacks.
                if (upsertSequence >= 32) { RejectUpsertQuery(query, "run-limit", "limit-reached"); return; }
                if (connection != null && (!MachineString(connection.BaseUrl, 4096) || connection.Encryption < 0)) { RejectUpsertQuery(query, "connection-invalid", null); return; }
                var expired = new List<object>();
                foreach (KeyValuePair<object, UpsertObservation> pair in UpsertObservations)
                    if (DateTime.UtcNow - pair.Value.Started > TimeSpan.FromMinutes(2)) expired.Add(pair.Key);
                foreach (object key in expired) RejectUpsertQuery(key, "lifetime-expired", null);
                object request = FieldValue(query, "request_");
                UpsertObservation existing;
                if (UpsertObservations.TryGetValue(query, out existing)) {
                    string failure = UpsertOwnerFailure(request, existing);
                    if (failure != null) { RejectUpsertQuery(query, failure, null); return; }
                    if (connection != null) { existing.Connection = connection; WriteUpsertProgress(existing); }
                    return;
                }
                string initialFailure = UpsertOwnerFailure(request, null);
                if (initialFailure != null) { RejectUpsertQuery(query, initialFailure, null); return; }
                UpsertLifetime lifetime = UpsertQueryLifetime(query);
                if (lifetime == null || lifetime.Retired) return;
                if (lifetime.Generation != loginGeneration) { RejectUpsertQuery(query, "source-generation", null); return; }
                if (DateTime.UtcNow - lifetime.Started > TimeSpan.FromMinutes(2)) { RejectUpsertQuery(query, "lifetime-expired", null); return; }
                if (UpsertObservations.Count >= 64) { RejectUpsertQuery(query, "pending-query-limit", null); return; }
                UpsertObservation observation = new UpsertObservation { Request = request, Player = loginPlayer, Card = loginCard, Client = loginClient,
                    Generation = lifetime.Generation, Session = session, Identity = loginIdentity, Machine = machineSnapshot, Started = lifetime.Started, Connection = connection, Lifetime = lifetime };
                if (request.GetType().IsValueType) {
                    observation.UserAll = FieldValue(request, "upsertUserAll");
                    observation.Region = (int)FieldValue(request, "regionId"); observation.Place = (uint)FieldValue(request, "placeId");
                }
                UpsertObservations[query] = observation;
                WriteUpsertProgress(observation);
            }
        } catch { RejectUpsertQuery(query, "request-metadata-unavailable", null); }
    }
    private static UpsertLifetime UpsertQueryLifetime(object query)
    {
        UpsertLifetime found = null;
        for (int i = UpsertLifetimes.Count - 1; i >= 0; i--) {
            object target = UpsertLifetimes[i].Query.Target;
            if (target == null) UpsertLifetimes.RemoveAt(i);
            else if (Object.ReferenceEquals(target, query)) found = UpsertLifetimes[i];
        }
        if (found != null) return found;
        // A still-live query keeps its first generation and expiry even after
        // rejection, response consumption, pruning, or a new Login. Weak
        // references keep neither game queries nor their payloads alive.
        if (UpsertLifetimes.Count >= 256) { RejectUpsertQuery(query, "weak-lifetime-limit", "limit-reached"); return null; }
        found = new UpsertLifetime { Query = new WeakReference(query), Generation = loginGeneration, Started = DateTime.UtcNow };
        UpsertLifetimes.Add(found); return found;
    }
    private static void RemoveUpsertQuery(object query)
    {
        UpsertObservation observation;
        if (UpsertObservations.TryGetValue(query, out observation)) {
            if (observation.Lifetime != null) observation.Lifetime.Retired = true;
            upsertRequestBytes = Math.Max(0, upsertRequestBytes - observation.RequestBytes);
            UpsertObservations.Remove(query);
        }
    }
    private static void IncrementWitnessCounter(ref int value) { if (value < Int32.MaxValue) value++; }
    private static void PruneUpsertWitnesses()
    {
        for (int i = UpsertClientWitnesses.Count - 1; i >= 0; i--) {
            UpsertClientWitness witness = UpsertClientWitnesses[i];
            if (witness.Client.Target == null || witness.Generation != loginGeneration || DateTime.UtcNow - witness.RetiredAt > TimeSpan.FromMinutes(2)) {
                if (Object.ReferenceEquals(witness, lastClientWitness)) lastClientWitness = null;
                UpsertClientWitnesses.RemoveAt(i);
            }
        }
    }
    private static void RejectUpsertQuery(object query, string reason, string state)
    {
        lock (Gate) {
            if (query == null || query.GetType().FullName != "MU3.Client.UpsertUserAll") return;
            foreach (UpsertLifetime prior in UpsertLifetimes)
                if (Object.ReferenceEquals(prior.Query.Target, query) && prior.Retired && !UpsertObservations.ContainsKey(query)) return;
            foreach (UpsertLifetime prior in UpsertLifetimes)
                if (Object.ReferenceEquals(prior.Query.Target, query)) prior.Retired = true;
            PruneUpsertWitnesses();
            UpsertObservation observation;
            lastClientWitness = null;
            if (query != null && UpsertObservations.TryGetValue(query, out observation)) {
                object client = observation.TransportClient == null ? null : observation.TransportClient.Target;
                if (client != null && client.GetType().FullName == "MU3.Client.NetHttpClient") {
                    if (UpsertClientWitnesses.Count >= 256) UpsertClientWitnesses.RemoveAt(0);
                    lastClientWitness = new UpsertClientWitness { Client = new WeakReference(client), Generation = observation.Generation,
                        RetiredAt = DateTime.UtcNow, Reason = reason };
                    UpsertClientWitnesses.Add(lastClientWitness);
                }
                RemoveUpsertQuery(query);
            }
            lastUpsertReason = reason;
            WriteUpsertStatus(state ?? ("rejected-" + reason));
        }
    }
    private static void ObserveRetiredUpsertClient(object client, bool completed)
    {
        PruneUpsertWitnesses();
        foreach (UpsertClientWitness witness in UpsertClientWitnesses) {
            if (!Object.ReferenceEquals(witness.Client.Target, client)) continue;
            if (completed) { witness.CompletedEntered = true; IncrementWitnessCounter(ref transportRetiredCompletions); }
            else { witness.SendEntered = true; IncrementWitnessCounter(ref transportRetiredSends); }
            // Late callbacks can update anonymous entry evidence only. They
            // never change status, the first reason, association or lifetime.
            if (Object.ReferenceEquals(witness, lastClientWitness)) WriteUpsertDiagnostics();
            return;
        }
    }
    private static void WriteUpsertDiagnostics()
    {
        lock (Gate) {
            try {
                PruneUpsertWitnesses();
                string text = "{\"version\":1,\"source\":\"passive-upsert-hook-diagnostics\",\"lastReason\":" + Quote(lastUpsertReason)
                    + ",\"sendHookEntries\":" + transportSendEntries + ",\"completedHookEntries\":" + transportCompletedEntries
                    + ",\"boundSendEntries\":" + transportBoundSends + ",\"boundCompletedEntries\":" + transportBoundCompletions
                    + ",\"retiredSendEntries\":" + transportRetiredSends + ",\"retiredCompletedEntries\":" + transportRetiredCompletions
                    + ",\"retiredWitnessCount\":" + UpsertClientWitnesses.Count + ",\"lastWitnessAvailable\":" + (lastClientWitness != null ? "true" : "false")
                    + ",\"lastRetiredSendEntered\":" + (lastClientWitness != null && lastClientWitness.SendEntered ? "true" : "false")
                    + ",\"lastRetiredCompletedEntered\":" + (lastClientWitness != null && lastClientWitness.CompletedEntered ? "true" : "false") + "}";
                Directory.CreateDirectory(root);
                File.WriteAllText(Path.Combine(root, "upsert-hook-diagnostics.json"), text, new UTF8Encoding(false));
            } catch { /* Diagnostics must not affect original calls or status. */ }
        }
    }
    private static void ReadUpsertRequest(object __instance, string __result)
    {
        try {
            lock (Gate) {
                RememberUpsertQuery(__instance, null);
                UpsertObservation observation;
                if (!upsertHooks || !Enabled() || __instance == null || !UpsertObservations.TryGetValue(__instance, out observation)) return;
                if (observation.TransportRequestObserved) return; // Never overwrite the already observed send bytes with a later serializer call.
                string failure = UpsertOwnerFailure(FieldValue(__instance, "request_"), observation);
                if (failure != null) { RejectUpsertQuery(__instance, failure, null); return; }
                if (String.IsNullOrEmpty(__result)) { RejectUpsertQuery(__instance, "legacy-request-empty", null); return; }
                if (__result.Length > 8 * 1024 * 1024) { RejectUpsertQuery(__instance, "legacy-request-character-limit", null); return; }
                int bytes = Encoding.UTF8.GetByteCount(__result);
                if (bytes > 8 * 1024 * 1024) { RejectUpsertQuery(__instance, "legacy-request-utf8-limit", null); return; }
                if (upsertRequestBytes - observation.RequestBytes + bytes > 16 * 1024 * 1024) { RejectUpsertQuery(__instance, "legacy-request-budget", null); return; }
                failure = ObservedUpsertRequestFailure(__result, observation, "legacy");
                if (failure != null) { RejectUpsertQuery(__instance, failure, null); return; }
                failure = SealUpsertPayload(FieldValue(__instance, "request_"), observation);
                if (failure != null) { RejectUpsertQuery(__instance, failure, null); return; }
                // This string is the game's actual getRequest return value. Do
                // not call getRequest, serialize, ToJson, or modify the request.
                observation.SerializedRequest = __result;
                upsertRequestBytes = upsertRequestBytes - observation.RequestBytes + bytes;
                observation.RequestBytes = bytes;
                WriteUpsertProgress(observation);
            }
        } catch { RejectUpsertQuery(__instance, "legacy-request-metadata-unavailable", null); }
    }
    private static void UpsertUserAgent(object __0, string __result)
    {
        try {
            lock (Gate) {
                RememberUpsertQuery(__0, null);
                UpsertObservation observation;
                if (!upsertHooks || !Enabled() || __0 == null || !UpsertObservations.TryGetValue(__0, out observation)) return;
                if (observation.TransportRequestObserved) return; // The actual request() argument is authoritative for this client.
                string failure = UpsertOwnerFailure(FieldValue(__0, "request_"), observation);
                if (failure != null) { RejectUpsertQuery(__0, failure, null); return; }
                if (!MachineString(__result, 512)) { RejectUpsertQuery(__0, "legacy-agent-invalid", null); return; }
                observation.Agent = __result;
                WriteUpsertProgress(observation);
            }
        } catch { RejectUpsertQuery(__0, "legacy-agent-metadata-unavailable", null); }
    }
    private static void ReadUpsertResponse(object __instance, string __0, bool __result)
    {
        try {
            lock (Gate) {
                UpsertObservation observation;
                if (__instance == null || !UpsertObservations.TryGetValue(__instance, out observation)) return;
                // Every rejection still consumes only this exact query. Keep
                // its first reason before releasing request references.
                if (upsertHooks && Enabled() && !__result) { RejectUpsertQuery(__instance, "legacy-response-parser-not-confirmed", "not-confirmed"); return; }
                string failure = !upsertHooks ? "hooks-unavailable" : !__result ? "legacy-response-parser-not-confirmed" : !Enabled() ? "capture-disabled"
                    : upsertSequence >= 32 ? "run-limit" : UpsertOwnerFailure(FieldValue(__instance, "request_"), observation);
                if (failure != null) { RejectUpsertQuery(__instance, failure, null); return; }
                if (String.IsNullOrEmpty(__0)) { RejectUpsertQuery(__instance, "legacy-response-empty", null); return; }
                if (__0.Length > 1024 * 1024) { RejectUpsertQuery(__instance, "legacy-response-character-limit", null); return; }
                if (Encoding.UTF8.GetByteCount(__0) > 1024 * 1024) { RejectUpsertQuery(__instance, "legacy-response-utf8-limit", null); return; }
                if (!observation.PayloadSealed || String.IsNullOrEmpty(observation.SerializedRequest) || observation.Connection == null
                    || !MachineString(observation.Connection.BaseUrl, 4096) || observation.Connection.Encryption < 0 || !MachineString(observation.Agent, 512)) {
                    RejectUpsertQuery(__instance, "legacy-response-context-incomplete", "incomplete"); return;
                }
                object code = FieldValue(FieldValue(__instance, "response_"), "returnCode");
                if (!(code is int) || (int)code != 1) { RejectUpsertQuery(__instance, "legacy-response-code-not-one", "not-confirmed"); return; }
                RemoveUpsertQuery(__instance);
                WriteConsumedUpsertObservation(observation, __0, "game-serialized-accepted-save", observation.TransportRequestObserved ? "net-http-request-query-response" : "query-hooks", "game-query-set-response", "unavailable");
            }
        } catch { RejectUpsertQuery(__instance, "legacy-response-metadata-unavailable", "unavailable"); }
    }
    private static void PublishUpsertObservation(object query, UpsertObservation observation, string response, string source, string path, string acceptance)
    {
        string failure = upsertSequence >= 32 ? "run-limit" : UpsertOwnerFailure(FieldValue(query, "request_"), observation);
        if (failure != null) { RejectUpsertQuery(query, failure, "transport-owner-or-lifetime-mismatch"); return; }
        RemoveUpsertQuery(query);
        WriteConsumedUpsertObservation(observation, response, source, path, acceptance, "transport-response-invalid");
    }
    private static void WriteConsumedUpsertObservation(UpsertObservation observation, string response, string source, string path, string acceptance, string failureState)
    {
        try { WriteUpsertObservation(observation, response, source, path, acceptance); ConfirmAppliedEdit(observation); }
        catch {
            // This is the current publication's IO failure, not a late query
            // callback. Preserve consumption and record no exception details.
            lastUpsertReason = "publication-write-failed"; lastClientWitness = null;
            WriteUpsertStatus(failureState);
        }
    }
    private static void WriteUpsertObservation(UpsertObservation observation, string response, string source, string path, string acceptance)
    {
        // These strings are actual original observations. Quoting them never
        // invokes commercial JSON or changes the game request or response.
        string output = "{\"version\":1,\"api\":\"UpsertUserAllApi\",\"source\":" + Quote(source) + ",\"observationPath\":" + Quote(path) + ",\"acceptance\":" + Quote(acceptance) + ",\"at\":" + Quote(DateTime.UtcNow.ToString("o"))
            + ",\"loginGeneration\":" + Quote(observation.Generation) + ",\"sessionId\":" + Quote(observation.Session) + ",\"identity\":" + observation.Identity
            + ",\"machine\":" + observation.Machine
            + ",\"serializedRequest\":" + Quote(observation.SerializedRequest) + ",\"serializedResponse\":" + Quote(response)
            + (observation.TransportRequestObserved ? ",\"compressionRequested\":" + (observation.TransportCompression ? "true" : "false") : "")
            + ",\"returnCode\":1,\"connection\":{\"baseUrl\":" + Quote(observation.Connection.BaseUrl) + ",\"encryptVersion\":" + observation.Connection.Encryption
            + ",\"userAgent\":" + Quote(observation.Agent) + "}}";
        string directory = Path.Combine(root, "upsert-observations"); Directory.CreateDirectory(directory);
        string target = Path.Combine(directory, Guid.NewGuid().ToString("N") + ".json");
        File.WriteAllText(target + ".tmp", output, new UTF8Encoding(false)); File.Move(target + ".tmp", target);
        upsertSequence++; lastUpsertReason = "none"; lastClientWitness = null; WriteUpsertStatus("captured");
    }
    private static void WriteUpsertStatus(string value)
    {
        try { Directory.CreateDirectory(root); File.WriteAllText(Path.Combine(root, "upsert-capture-status.txt"), value, Encoding.UTF8); } catch { }
        WriteUpsertDiagnostics();
    }
    private static void WriteUpsertProgress(UpsertObservation observation)
    {
        bool request = !String.IsNullOrEmpty(observation.SerializedRequest), agent = !String.IsNullOrEmpty(observation.Agent);
        WriteUpsertStatus(request && agent && observation.Connection != null ? "waiting-for-response"
            : request ? "request-observed" : agent ? "agent-observed" : "query-observed");
    }
    private static void ReadResponse(object __instance, string __0, bool __result)
    {
        try {
            if (!__result || !Enabled() || String.IsNullOrEmpty(__0) || __0.Length > 8 * 1024 * 1024) return;
            object request = AccessTools.Field(__instance.GetType(), "request_").GetValue(__instance);
            string id = Convert.ToString(AccessTools.Field(request.GetType(), "userId").GetValue(request));
            if (String.IsNullOrEmpty(id) || id == "0") return;
            // JsonUtility is already used by the game's protocol serializer.
            Type json = AccessTools.TypeByName("UnityEngine.JsonUtility");
            string requestJson = (string)AccessTools.Method(json, "ToJson", new Type[] { typeof(object) }).Invoke(null, new object[] { request });
            lock (Gate) {
                if (player != id) { player = id; session = Guid.NewGuid().ToString("N"); sequence = 0; }
                if (sequence >= 2000) return;
                Connection connection;
                Connections.TryGetValue(__instance, out connection); Connections.Remove(__instance);
                string metadata = connection == null ? "null" : "{\"baseUrl\":" + Quote(connection.BaseUrl) + ",\"encryptVersion\":" + connection.Encryption + ",\"userAgent\":" + Quote(connection.Agent) + "}";
                string output = "{\"api\":" + Quote(__instance.GetType().Name + "Api") + ",\"at\":" + Quote(DateTime.UtcNow.ToString("o")) + ",\"request\":" + requestJson + ",\"response\":" + __0 + ",\"connection\":" + metadata + "}";
                string dir = Path.Combine(Path.Combine(root, "captures"), session); Directory.CreateDirectory(dir);
                WriteIdentity(dir, id);
                string target = Path.Combine(dir, (++sequence).ToString("D6") + ".json");
                File.WriteAllText(target + ".tmp", output, new UTF8Encoding(false)); File.Move(target + ".tmp", target);
                WriteStatus("capturing");
            }
        } catch (Exception ex) { WriteStatus("capture-error: " + ex.GetType().Name); /* No player data or response bodies. */ }
    }
    private static void WriteIdentity(string dir, string id)
    {
        string identity = Path.Combine(dir, "identity.json");
        if (loginIdentity != null && loginPlayer == id && !File.Exists(identity)) {
            File.WriteAllText(identity + ".tmp", loginIdentity, new UTF8Encoding(false));
            File.Move(identity + ".tmp", identity);
        }
    }
    private static bool Digits(string value, int length)
    {
        if (value == null || value.Length != length) return false;
        foreach (char c in value) if (c < '0' || c > '9') return false;
        return true;
    }
    private static string ReadMachineSnapshot(string file)
    {
        try {
            if (!File.Exists(file) || new FileInfo(file).Length > 1024 * 1024) return null;
            string text;
            // BOM detection also covers UTF-16; legacy Chinese INIs use GBK.
            try { using (var reader = new StreamReader(file, new UTF8Encoding(false, true), true)) text = reader.ReadToEnd(); }
            catch (DecoderFallbackException) { text = File.ReadAllText(file, Encoding.GetEncoding(936)); }
            var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            values["dns.default"] = ""; values["dns.AimeDB"] = ""; values["dns.replaceHost"] = "0";
            values["netenv.enable"] = "1"; values["keychip.id"] = ""; values["keychip.subnet"] = "192.168.162.0";
            string section = "";
            using (var reader = new StringReader(text)) {
                string line;
                while ((line = reader.ReadLine()) != null) {
                    line = line.Trim().TrimStart('\uFEFF');
                    if (line.Length == 0 || line[0] == ';' || line[0] == '#') continue;
                    if (line[0] == '[' && line.IndexOf(']') > 0) { section = line.Substring(1, line.IndexOf(']') - 1).Trim(); continue; }
                    int equal = line.IndexOf('='); if (equal < 1) continue;
                    string key = section + "." + line.Substring(0, equal).Trim();
                    if (!values.ContainsKey(key)) continue;
                    string value = line.Substring(equal + 1).Trim();
                    for (int i = 1; i < value.Length; i++) if ((value[i] == ';' || value[i] == '#') && Char.IsWhiteSpace(value[i - 1])) { value = value.Substring(0, i).TrimEnd(); break; }
                    if (value.Length >= 2 && value[0] == '"' && value[value.Length - 1] == '"') value = value.Substring(1, value.Length - 2);
                    if (value.Length > 1024 || value.IndexOf('\0') >= 0) return null;
                    values[key] = value;
                }
            }
            return "{\"dns\":{\"default\":" + Quote(values["dns.default"]) + ",\"AimeDB\":" + Quote(values["dns.AimeDB"]) + ",\"replaceHost\":" + Quote(values["dns.replaceHost"]) + "},\"netenv\":{\"enable\":" + Quote(values["netenv.enable"]) + "},\"keychip\":{\"id\":" + Quote(values["keychip.id"]) + ",\"subnet\":" + Quote(values["keychip.subnet"]) + "}}";
        } catch { return null; /* Configuration capture must not prevent read capture. */ }
    }
    private static string Quote(string value)
    {
        var b = new StringBuilder("\"");
        foreach (char c in value ?? "") {
            if (c == '"' || c == '\\') b.Append('\\').Append(c);
            else if (c < 32) b.Append("\\u").Append(((int)c).ToString("x4"));
            else b.Append(c);
        }
        return b.Append('"').ToString();
    }
    private void OnDestroy() { WriteStatus("stopped"); try { if (harmony != null) harmony.UnpatchAll("com.ogk.toolbox.playercapture"); } catch { } }
}
