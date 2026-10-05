using System;
using System.Collections;
using System.Collections.Generic;
using System.Reflection;

public sealed partial class PlayerCapture
{
    // Task files are our own DTOs, not Unity objects. Keep their decoding managed,
    // deterministic and testable without Unity's native serialization/type registry.
    private sealed partial class ObservedJson
    {
        public object DeserializeEdit(Type type)
        {
            if (text == null || text.Length > 1024 * 1024) throw new FormatException();
            object result = EditValue(type, 0);
            Space(); if (index != text.Length) throw new FormatException();
            return result;
        }
        private object EditValue(Type type, int depth)
        {
            Space(); if (depth > 16 || index >= text.Length) throw new FormatException();
            if (type == typeof(string)) return String(true);
            if (type == typeof(int)) {
                if (text[index] != '-' && (text[index] < '0' || text[index] > '9')) throw new FormatException();
                int value;
                if (!Int32.TryParse(Number(), System.Globalization.NumberStyles.AllowLeadingSign, System.Globalization.CultureInfo.InvariantCulture, out value)) throw new FormatException();
                return value;
            }
            if (type == typeof(bool)) {
                if (text[index] == 't') { Literal("true"); return true; }
                if (text[index] == 'f') { Literal("false"); return false; }
                throw new FormatException();
            }
            if (type.IsArray) {
                if (!Take('[')) throw new FormatException();
                var rows = new ArrayList();
                if (!Take(']')) {
                    do {
                        if (rows.Count >= 5000) throw new FormatException();
                        rows.Add(EditValue(type.GetElementType(), depth + 1));
                        if (Take(']')) return rows.ToArray(type.GetElementType());
                    } while (Take(','));
                    throw new FormatException();
                }
                return rows.ToArray(type.GetElementType());
            }
            if (type != typeof(EditCommand) && type != typeof(EditResource) && type != typeof(EditScore)
                && type != typeof(EditMachine) && type != typeof(EditDns)) throw new FormatException();
            if (!Take('{')) throw new FormatException();
            object instance = Activator.CreateInstance(type);
            var keys = new HashSet<string>(StringComparer.Ordinal);
            if (!Take('}')) {
                while (true) {
                    string key = String(true);
                    if (keys.Count >= 128 || !keys.Add(key) || !Take(':')) throw new FormatException();
                    FieldInfo field = type.GetField(key, BindingFlags.Public | BindingFlags.Instance);
                    if (field == null) { string ignored; Value(depth + 1, false, out ignored); }
                    else field.SetValue(instance, EditValue(field.FieldType, depth + 1));
                    if (Take('}')) break;
                    if (!Take(',')) throw new FormatException();
                }
            }
            // Missing targets must not silently become zero/false.
            if (type == typeof(EditScore)) {
                RequireEditKeys(keys, new string[] { "musicId", "difficulty", "platinumMax", "fields" });
                RequireEditKeys(keys, ((EditScore)instance).fields);
            } else foreach (FieldInfo field in type.GetFields(BindingFlags.Public | BindingFlags.Instance)) {
                if (!keys.Contains(field.Name)) throw new FormatException();
            }
            return instance;
        }
        private static void RequireEditKeys(HashSet<string> keys, string[] required)
        {
            if (required == null) throw new FormatException();
            foreach (string key in required) if (!keys.Contains(key)) throw new FormatException();
        }
    }
}
