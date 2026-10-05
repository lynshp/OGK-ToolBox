using System;
using System.IO;
using System.Text;
using System.Reflection;
using System.Collections;
using System.Collections.Generic;
using System.Security.Cryptography;
using HarmonyLib;

// Commands contain targets only. They are applied once after native login initialization;
// all network writes and cabinet backup updates remain owned by the game.
public sealed partial class PlayerCapture
{
    [Serializable] public sealed class EditResource { public string key; public int value; }
    [Serializable] public sealed class EditScore
    {
        public int musicId, difficulty, techScore, platinumScore, battleScore, platinumMax;
        public bool fullCombo, fullBell, allBreak;
        public int playCount, maxComboCount, maxOverKill, maxTeamOverKill, battleScoreRank, clearStatus;
        public string[] fields;
    }
    [Serializable] public sealed class EditCommand
    {
        public int version; public string id, host, accessCode, clientId, createdAt;
        public EditResource[] resources; public EditScore[] scores;
    }
    [Serializable] public sealed class EditDns { public string @default; }
    [Serializable] public sealed class EditMachine { public EditDns dns; }
    private static EditCommand activeEdit;
    private static string activeEditFile, activeEditSession, appliedEditGeneration;
    private static readonly HashSet<string> editRemaining = new HashSet<string>();
    private static bool editHooks;
    private static DateTime editAppliedAt;

    private void InitializeEditHooks()
    {
        try {
            Type manager = AccessTools.TypeByName("MU3.User.UserManager");
            MethodInfo method = manager == null ? null : AccessTools.Method(manager, "initializeOnLogin", Type.EmptyTypes);
            if (!upsertHooks || method == null || method.IsStatic || method.ReturnType != typeof(void)) throw new InvalidOperationException();
            harmony.Patch(method, postfix: new HarmonyMethod(typeof(PlayerCapture), "ApplyEditsAfterLogin"));
            editHooks = true; EditStatus("ready");
        } catch { editHooks = false; EditStatus("unsupported"); }
    }
    private static object EditJson(string text, Type type)
    {
        return new ObservedJson(text).DeserializeEdit(type);
    }
    private static string EditHost(string value)
    {
        Uri uri;
        if (String.IsNullOrEmpty(value) || !Uri.TryCreate(value.IndexOf("://") >= 0 ? value : "http://" + value, UriKind.Absolute, out uri)
            || (uri.Scheme != "http" && uri.Scheme != "https") || !String.IsNullOrEmpty(uri.UserInfo)) return null;
        return uri.Host.ToLowerInvariant().TrimEnd('.') + (uri.IsDefaultPort ? "" : ":" + uri.Port);
    }
    private static string EditKey(string host, string card, string client)
    {
        using (SHA256 hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(host + "\n" + card + "\n" + client))).Replace("-", "").ToLowerInvariant();
    }
    private static object EditGet(object value, string name) { return AccessTools.Property(value.GetType(), name).GetValue(value, null); }
    private static void EditSet(object value, string name, object next)
    {
        PropertyInfo property = AccessTools.Property(value.GetType(), name);
        if (property.PropertyType.IsEnum) next = Enum.ToObject(property.PropertyType, next);
        property.GetSetMethod(true).Invoke(value, new object[] { next });
    }
    private static object EditCall(object value, string name, params object[] args)
    {
        Type[] types = new Type[args.Length]; for (int i = 0; i < args.Length; i++) types[i] = args[i].GetType();
        return AccessTools.Method(value.GetType(), name, types).Invoke(value, args);
    }
    private static void EditQuantity(object target, string property, string add, string sub, int next)
    {
        int previous = Convert.ToInt32(EditGet(target, property));
        if (next > previous) EditCall(target, add, next - previous);
        else if (next < previous) EditCall(target, sub, previous - next);
        if (Convert.ToInt32(EditGet(target, property)) != next) throw new InvalidOperationException();
    }
    private static string ItemMethod(int kind)
    {
        switch (kind) {
            case 11: return "getUserGachaTicket"; case 12: return "getUserKaikaItem";
            case 13: return "getUserExpUpItem"; case 14: return "getUserIntimateUpItem";
            case 20: return "getUserUnlockItem"; default: throw new InvalidOperationException();
        }
    }
    private static List<Action> PlanEdit(object manager, EditCommand command)
    {
        if (command == null || command.version != 1 || String.IsNullOrEmpty(command.id) || command.id.Length > 80
            || command.resources == null || command.scores == null || command.resources.Length + command.scores.Length == 0
            || command.resources.Length + command.scores.Length > 5000 || command.scores.Length > 0 && command.host != "play.mumur.net") throw new InvalidOperationException();
        var actions = new List<Action>(); var keys = new HashSet<string>();
        foreach (EditResource resource in command.resources) {
            EditResource row = resource;
            if (row == null || row.key == null || row.value < 0 || !keys.Add(row.key)) throw new InvalidOperationException();
            string[] parts = row.key.Split(':'); int id;
            if (parts.Length == 2 && parts[0] == "data") {
                string property, add, sub; int max;
                switch (parts[1]) {
                    case "point": property = "Money"; add = "AddMoney"; sub = "SubMoney"; max = 999999999; break;
                    case "jewelCount": property = "AlmightySphereCount"; add = "AddAlmightySphereCount"; sub = "SubAlmightySphereCount"; max = 99999; break;
                    case "medalCount": property = "MedalCount"; add = "AddMedalCount"; sub = "SubMedalCount"; max = 999999; break;
                    case "shizukuCount": property = "SizukuCount"; add = "AddSizukuCount"; sub = "SubSizukuCount"; max = 999999; break;
                    default: throw new InvalidOperationException();
                }
                if (row.value > max) throw new InvalidOperationException();
                object detail = EditGet(manager, "userDetail");
                actions.Add(delegate { if (Convert.ToInt32(EditGet(detail, property)) != row.value) editRemaining.Add(row.key); EditQuantity(detail, property, add, sub, row.value); });
            } else if (parts.Length == 2 && (parts[0] == "chapter" || parts[0] == "story") && Int32.TryParse(parts[1], out id) && id >= 0 && row.value <= 99999) {
                bool chapter = parts[0] == "chapter"; int targetId = id;
                string method = chapter ? "getUserChapter" : "getUserStory";
                actions.Add(delegate { object target = EditCall(manager, method, targetId, true); if (Convert.ToInt32(EditGet(target, chapter ? "SphereCount" : "JewelCount")) != row.value) editRemaining.Add(row.key); EditQuantity(target, chapter ? "SphereCount" : "JewelCount", "AddJewelCount", chapter ? "SubSphereCount" : "SubJewelCount", row.value); });
            } else if (parts.Length == 3 && parts[0] == "item" && Int32.TryParse(parts[2], out id) && id >= 0) {
                int kind; if (!Int32.TryParse(parts[1], out kind)) throw new InvalidOperationException();
                string method = ItemMethod(kind); int targetId = id;
                if (row.value > (kind == 11 ? 99 : kind == 20 ? 1 : 9999)) throw new InvalidOperationException();
                if (kind == 20 && row.value != 1) throw new InvalidOperationException();
                actions.Add(delegate { object previous = EditCall(manager, method, targetId, false); object target = EditCall(manager, method, targetId, true); if (kind == 20) { if (previous == null) editRemaining.Add(row.key); } else { if (Convert.ToInt32(EditGet(target, "Num")) != row.value) editRemaining.Add(row.key); EditQuantity(target, "Num", "addCount", "subCount", row.value); } });
            } else throw new InvalidOperationException();
        }
        if (command.scores.Length > 0) {
            Type dmType = AccessTools.TypeByName("MU3.Data.DataManager"), difficultyType = AccessTools.TypeByName("MU3.FumenDifficulty");
            // The parameter type is taken from the actual method, not a guessed enum namespace.
            MethodInfo getFumen = AccessTools.Method(manager.GetType(), "getUserFumen");
            difficultyType = getFumen.GetParameters()[1].ParameterType;
            object dataManager = AccessTools.Property(dmType, "instance").GetValue(null, null), gameData = EditGet(dataManager, "gameData");
            foreach (EditScore score in command.scores) {
                EditScore row = score;
                if (row == null || row.musicId < 0 || row.difficulty < 0 || row.difficulty > 4 || row.techScore < 0 || row.techScore > 1010000
                    || row.platinumScore < 0 || row.battleScore < 0 || !keys.Add("score:" + row.musicId + ":" + row.difficulty)) throw new InvalidOperationException();
                if (row.fields == null || row.fields.Length == 0 || row.fields.Length > 12) throw new InvalidOperationException();
                foreach (string field in row.fields) if (Array.IndexOf(new string[] { "techScore", "platinumScore", "battleScore", "fullCombo", "fullBell", "allBreak", "playCount", "maxComboCount", "maxOverKill", "maxTeamOverKill", "battleScoreRank", "clearStatus" }, field) < 0) throw new InvalidOperationException();
                if (row.playCount < 0 || EditField(row, "playCount") && row.playCount == 0 || row.maxComboCount < 0 || row.maxOverKill < 0 || row.maxTeamOverKill < 0 || row.battleScoreRank < 0 || row.battleScoreRank > 11 || row.clearStatus < 0 || row.clearStatus > 1) throw new InvalidOperationException();
                object difficulty = Enum.ToObject(difficultyType, row.difficulty);
                object analysis = EditCall(dataManager, "getFumenAnalysisData", row.musicId, difficulty);
                int maximum = Convert.ToInt32(FieldValue(analysis, "platinumScoreMax"));
                if (maximum <= 0 || row.platinumMax >= 0 && row.platinumMax != maximum || EditField(row, "platinumScore") && row.platinumScore > maximum) throw new InvalidOperationException();
                actions.Add(delegate {
                    object fumen = getFumen.Invoke(manager, new object[] { row.musicId, difficulty, true });
                    if (EditField(row, "techScore")) {
                        int raw = Convert.ToInt32(EditGet(fumen, "TechScoreMaxRaw"));
                        EditSet(fumen, "TechScoreMaxRaw", row.techScore == 1010000 && raw > 1010000 && raw <= 1019999 ? raw : row.techScore);
                        EditSet(fumen, "TechScoreRank", Convert.ToInt32(EditCall(gameData, "calcTechnicalRank", row.techScore)));
                    }
                    if (EditField(row, "platinumScore")) {
                        EditSet(fumen, "PlatinumScoreMax", row.platinumScore);
                        EditSet(fumen, "PlatinumScoreRank", Convert.ToInt32(EditCall(gameData, "GetPlatinumScoreRank", row.platinumScore, maximum)));
                        EditSet(fumen, "PlatinumScorePercent", EditCall(gameData, "GetPlatinumScorePercent", row.platinumScore, maximum));
                    }
                    if (EditField(row, "battleScore")) EditSet(fumen, "BattleScoreMax", row.battleScore);
                    if (EditField(row, "fullCombo") || EditField(row, "allBreak") && row.allBreak || EditField(row, "techScore") && row.techScore == 1010000) EditSet(fumen, "IsFullCombo", row.fullCombo || row.allBreak || row.techScore == 1010000);
                    if (EditField(row, "fullBell") || EditField(row, "techScore") && row.techScore == 1010000) EditSet(fumen, "IsFullBell", row.fullBell || row.techScore == 1010000);
                    if (EditField(row, "allBreak") || EditField(row, "techScore") && row.techScore == 1010000) EditSet(fumen, "IsAllBreak", row.allBreak || row.techScore == 1010000);
                    if (EditField(row, "playCount")) EditSet(fumen, "PlayCount", row.playCount);
                    if (EditField(row, "maxComboCount")) EditSet(fumen, "MaxComboCount", row.maxComboCount);
                    if (EditField(row, "maxOverKill")) EditSet(fumen, "OverDamageMaxX100", row.maxOverKill);
                    if (EditField(row, "maxTeamOverKill")) EditSet(fumen, "TeamOverDamageMaxX100", row.maxTeamOverKill);
                    if (EditField(row, "battleScoreRank")) EditSet(fumen, "BattleScoreRank", row.battleScoreRank);
                    if (EditField(row, "clearStatus")) EditSet(fumen, "IsClear", row.clearStatus == 1);
                    if (Convert.ToInt32(EditGet(fumen, "PlayCount")) == 0) EditCall(fumen, "AddPlayCount", 1);
                    if (Convert.ToInt32(EditGet(fumen, "TechScoreMax")) == 1010000) { EditSet(fumen, "IsAllBreak", true); EditSet(fumen, "IsFullBell", true); }
                    if ((bool)EditGet(fumen, "IsAllBreak")) EditSet(fumen, "IsFullCombo", true);
                    if ((bool)EditGet(fumen, "IsNewOrModified")) editRemaining.Add("score:" + row.musicId + ":" + row.difficulty);
                });
            }
            actions.Add(delegate { EditCall(manager, "updateUserRating"); EditCall(manager, "updateUserNewRating"); EditCall(manager, "updateTotalHiScore"); EditCall(EditGet(manager, "userBattlePoint"), "initBP"); });
        }
        return actions;
    }
    private static bool EditField(EditScore row, string field) { return row.fields != null && Array.IndexOf(row.fields, field) >= 0; }
    private static void ApplyEditsAfterLogin(object __instance)
    {
        lock (Gate) {
            string editPrefix = null, stage = "login-identity"; EditCommand candidate = null;
            try {
                if (!editHooks || !Enabled() || !loginSaveAccepted || appliedEditGeneration == loginGeneration || Convert.ToString(EditGet(__instance, "UserId")) != loginPlayer || (bool)EditGet(__instance, "IsGuest")) return;
                appliedEditGeneration = loginGeneration; activeEdit = null; editRemaining.Clear();
                stage = "machine-json";
                EditMachine machine = (EditMachine)EditJson(machineSnapshot, typeof(EditMachine));
                stage = "machine-host";
                string host = EditHost(machine.dns.@default);
                if (host == null) { EditStatus("invalid-server"); return; }
                stage = "task-path";
                string prefix = Path.Combine(Path.Combine(root, "edits"), EditKey(host, loginCard, loginClient));
                editPrefix = prefix;
                if (File.Exists(prefix + ".active.json")) { EditStatus("needs-review"); return; }
                string file = prefix + ".pending.json";
                if (!File.Exists(file)) { EditStatus("no-task"); return; }
                stage = "task-json";
                if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0 || new FileInfo(file).Length > 1024 * 1024) throw new InvalidOperationException();
                string commandText = File.ReadAllText(file);
                EditCommand command = (EditCommand)EditJson(commandText, typeof(EditCommand)); candidate = command;
                if (command.host != host || command.accessCode != loginCard || command.clientId != loginClient) throw new InvalidOperationException();
                stage = "task-apply";
                ApplyEditCommand(__instance, command, commandText, file, prefix);
            } catch (Exception error) {
                activeEdit = null; EditStatus("needs-review");
                WriteEditFailure(stage, error);
                try { if (editPrefix != null && candidate != null) File.WriteAllText(editPrefix + ".error.json", "{\"id\":" + Quote(candidate.id) + ",\"issue\":" + Quote(File.Exists(editPrefix + ".active.json") ? "interrupted" : "incompatible") + "}", new UTF8Encoding(false)); } catch { }
            }
        }
    }
    private static void WriteEditFailure(string stage, Exception error)
    {
        try {
            while (error is TargetInvocationException && error.InnerException != null) error = error.InnerException;
            // Never log exception messages, JSON, card identity or runtime values.
            File.WriteAllText(Path.Combine(root, "edits-diagnostics.json"), "{\"stage\":" + Quote(stage) + ",\"exception\":" + Quote(error.GetType().Name) + ",\"at\":" + Quote(DateTime.UtcNow.ToString("o")) + "}", new UTF8Encoding(false));
        } catch { }
    }
    private static void ApplyEditCommand(object manager, EditCommand command, string commandText, string file, string prefix)
    {
        List<Action> plan = PlanEdit(manager, command);
        File.Move(file, prefix + ".active.json"); // Journal before the first mutation; no automatic crash replay.
        if (File.ReadAllText(prefix + ".active.json") != commandText) throw new InvalidOperationException();
        activeEditFile = prefix; activeEditSession = session; editRemaining.Clear();
        foreach (Action action in plan) action();
        editAppliedAt = DateTime.UtcNow; activeEdit = command; EditStatus("applied-awaiting-save");
        CompleteEditIfReady();
    }
    private static void ConfirmAppliedEdit(UpsertObservation observation)
    {
        if (activeEdit == null || observation.Started < editAppliedAt || observation.Session != activeEditSession || observation.Card != activeEdit.accessCode || observation.Client != activeEdit.clientId) return;
        object all = observation.UserAll;
        foreach (EditResource row in activeEdit.resources) {
            string[] parts = row.key.Split(':');
            if (parts[0] == "data") { if (HasEditRow(all, "userData", null, 0, null, 0)) editRemaining.Remove(row.key); }
            else if (parts[0] == "item") { if (HasEditRow(all, "userItemList", "itemKind", Int32.Parse(parts[1]), "itemId", Int32.Parse(parts[2]))) editRemaining.Remove(row.key); }
            else if (HasEditRow(all, parts[0] == "chapter" ? "userChapterList" : "userStoryList", parts[0] + "Id", Int32.Parse(parts[1]), null, 0)) editRemaining.Remove(row.key);
        }
        foreach (EditScore row in activeEdit.scores) if (HasEditRow(all, "userMusicDetailList", "musicId", row.musicId, "level", row.difficulty == 4 ? 10 : row.difficulty)) editRemaining.Remove("score:" + row.musicId + ":" + row.difficulty);
        CompleteEditIfReady();
    }
    private static void CompleteEditIfReady()
    {
        if (activeEdit == null || editRemaining.Count != 0) return;
        string complete = activeEditFile + ".complete.json";
        if (File.Exists(complete)) File.Delete(complete);
        File.Move(activeEditFile + ".active.json", complete);
        activeEdit = null; EditStatus("complete");
    }
    private static bool HasEditRow(object all, string list, string first, int firstId, string second, int secondId)
    {
        IEnumerable rows = FieldValue(all, list) as IEnumerable;
        if (rows == null) return false;
        foreach (object row in rows) if (row != null && (first == null || Convert.ToInt32(FieldValue(row, first)) == firstId) && (second == null || Convert.ToInt32(FieldValue(row, second)) == secondId)) return true;
        return false;
    }
    private static void EditStatus(string state) { try { Directory.CreateDirectory(root); File.WriteAllText(Path.Combine(root, "edits-status.txt"), state, new UTF8Encoding(false)); } catch { } }
}
