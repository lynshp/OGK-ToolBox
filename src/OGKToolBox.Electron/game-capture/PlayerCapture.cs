using System;
using System.IO;
using System.Reflection;
using System.Collections.Generic;
using System.Text;
using BepInEx;
using HarmonyLib;

// No game assemblies are distributed or referenced. Observe successful read responses only.
[BepInPlugin("com.ogk.toolbox.playercapture", "OGK Player Capture", "1.0.3")]
public sealed class PlayerCapture : BaseUnityPlugin
{
    private static readonly string[] Names = { "GetUserData", "GetUserMusic", "GetUserCard", "GetUserCharacter", "GetUserItem", "GetUserOption", "GetUserActivity" };
    private static readonly object Gate = new object();
    private static readonly Dictionary<object, Connection> Connections = new Dictionary<object, Connection>();
    [ThreadStatic] private static object activeQuery;
    private static string session = Guid.NewGuid().ToString("N");
    private static string player = "";
    private static int sequence;
    private static string root;
    private static string status = "initializing";
    private static DateTime nextHeartbeat;
    private Harmony harmony;

    private sealed class Connection { public string BaseUrl; public int Encryption; public string Agent; }
    private void Awake()
    {
        try {
            // Unity 5's Mono exposes the .NET 2.0 API: only the two-argument overload exists.
            root = Path.Combine(Path.Combine(Path.Combine(Paths.GameRootPath, "Tools"), "OGKToolBox"), "player-data");
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
                if (method == null && name == "GetUserActivity") continue;
                if (method == null || method.ReturnType != typeof(bool)) throw new InvalidOperationException("Unsupported game response type: " + name);
                harmony.Patch(method, postfix: new HarmonyMethod(typeof(PlayerCapture), "ReadResponse"));
            }
            Type packet = AccessTools.TypeByName("MU3.Client.Packet");
            harmony.Patch(AccessTools.Method(packet, "create"), prefix: new HarmonyMethod(typeof(PlayerCapture), "BeginPacket"), postfix: new HarmonyMethod(typeof(PlayerCapture), "EndPacket"));
            Type http = AccessTools.TypeByName("MU3.Client.NetHttpClient");
            // Packet.create calls the static factory, whose constructor does not call instance create.
            harmony.Patch(AccessTools.Method(http, "Create", new Type[] { typeof(uint), typeof(ushort), typeof(string), typeof(string), typeof(string), typeof(int), typeof(bool), typeof(int) }), prefix: new HarmonyMethod(typeof(PlayerCapture), "Connect"));
            Type login = AccessTools.TypeByName("MU3.Client.GameLogin");
            if (login != null) harmony.Patch(AccessTools.Method(login, "setResponse"), postfix: new HarmonyMethod(typeof(PlayerCapture), "Login"));
    }
    private static void WriteStatus(string value)
    {
        lock (Gate) {
            status = value;
            nextHeartbeat = DateTime.UtcNow.AddSeconds(5);
            try {
                Directory.CreateDirectory(root);
                File.WriteAllText(Path.Combine(root, "capture-status.txt"), value, Encoding.UTF8);
            } catch { /* Status reporting must not affect the game. */ }
        }
    }
    private void Update() { if (DateTime.UtcNow >= nextHeartbeat) WriteStatus(status); }
    private static bool Enabled() { return File.Exists(Path.Combine(root, "capture.enabled")); }
    private static void BeginPacket(object __0) { activeQuery = __0; }
    private static void EndPacket() { activeQuery = null; }
    private static void Login(bool __result) { if (__result) lock (Gate) { session = Guid.NewGuid().ToString("N"); player = ""; sequence = 0; Connections.Clear(); WriteStatus("ready"); } }
    private static void Connect(object[] __args)
    {
        try {
            if (!Enabled() || activeQuery == null || Array.IndexOf(Names, activeQuery.GetType().Name) < 0) return;
            string api = activeQuery.GetType().Name + "Api", requestPath = (string)__args[4];
            string authority = (string)__args[3];
            string baseUrl = ((bool)__args[6] ? "https://" : "http://") + authority + requestPath;
            int encryption = (int)__args[5];
            if (requestPath.EndsWith(api, StringComparison.Ordinal)) baseUrl = baseUrl.Substring(0, baseUrl.Length - api.Length);
            else encryption = Math.Max(1, encryption);
            var utility = AccessTools.TypeByName("MU3.Client.NetPacketUtil");
            string agent = (string)AccessTools.Method(utility, "getUserAgent").Invoke(null, new object[] { activeQuery });
            lock (Gate) {
                if (Connections.Count > 1000) Connections.Clear();
                Connections[activeQuery] = new Connection { BaseUrl = baseUrl, Encryption = encryption, Agent = agent };
            }
        } catch { /* A capture failure must never affect the game request. */ }
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
                string target = Path.Combine(dir, (++sequence).ToString("D6") + ".json");
                File.WriteAllText(target + ".tmp", output, new UTF8Encoding(false)); File.Move(target + ".tmp", target);
                WriteStatus("capturing");
            }
        } catch (Exception ex) { WriteStatus("capture-error: " + ex.GetType().Name); /* No player data or response bodies. */ }
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
