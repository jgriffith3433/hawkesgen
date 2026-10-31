// Imports a Hawkes Gen world pack (world.export's zip, or its unzipped world.json) into Assets/HawkesWorlds/<world>/:
// every file copied at its path in the pack, a skybox material per place with a panorama (Skybox/Panoramic), and a
// WorldPack asset that lists the characters, places, props and look with their files. GLB models import through
// glTFast (com.unity.cloud.gltfast) when the project has it; FBX models import as usual. docs/finishing.md.

using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using UnityEditor;
using UnityEngine;

namespace HawkesGen
{
    public static class WorldPackImporter
    {
        const string Root = "Assets/HawkesWorlds";

        [MenuItem("Hawkes Gen/Import World Pack...")]
        static void ImportMenu()
        {
            var path = EditorUtility.OpenFilePanelWithFilters("Import a Hawkes Gen world pack", "", new[] { "World pack", "zip,json" });
            if (string.IsNullOrEmpty(path)) return;
            var pack = Import(path);
            if (pack != null)
            {
                Selection.activeObject = pack;
                EditorGUIUtility.PingObject(pack);
            }
        }

        /// <summary>Imports a pack from a .zip or a world.json; returns the WorldPack asset.</summary>
        public static WorldPack Import(string path)
        {
            string sourceDir;
            string temp = null;
            if (path.EndsWith(".zip", System.StringComparison.OrdinalIgnoreCase))
            {
                temp = Path.Combine(Path.GetTempPath(), "hawkes-world-" + System.Guid.NewGuid().ToString("N"));
                ZipFile.ExtractToDirectory(path, temp);
                var manifests = Directory.GetFiles(temp, "world.json", SearchOption.AllDirectories);
                if (manifests.Length == 0) { Debug.LogError("Hawkes Gen: no world.json in " + path); return null; }
                sourceDir = Path.GetDirectoryName(manifests[0]);
            }
            else sourceDir = Path.GetDirectoryName(path);

            try
            {
                var m = MiniJson.Parse(File.ReadAllText(Path.Combine(sourceDir, "world.json"))) as Dictionary<string, object>;
                if (m == null || Str(m, "format") != "hawkes.world/1") { Debug.LogError("Hawkes Gen: not a world pack (format hawkes.world/1)"); return null; }
                var world = m["world"] as Dictionary<string, object>;
                var folder = Root + "/" + Safe(Str(world, "name"));
                Directory.CreateDirectory(folder);
                // Every file listed, at its path in the pack.
                foreach (var f in List(m, "files"))
                {
                    var rel = Str(f as Dictionary<string, object>, "path");
                    if (string.IsNullOrEmpty(rel) || rel.Contains("..")) continue;
                    var from = Path.Combine(sourceDir, rel);
                    if (!File.Exists(from)) continue;
                    var to = Path.Combine(folder, rel);
                    Directory.CreateDirectory(Path.GetDirectoryName(to));
                    File.Copy(from, to, true);
                }
                foreach (var extra in new[] { "README.md", "world.json", "look/palette.gpl" })
                {
                    var from = Path.Combine(sourceDir, extra);
                    if (File.Exists(from)) { Directory.CreateDirectory(Path.GetDirectoryName(Path.Combine(folder, extra))); File.Copy(from, Path.Combine(folder, extra), true); }
                }
                AssetDatabase.Refresh();

                var pack = ScriptableObject.CreateInstance<WorldPack>();
                pack.worldId = Str(world, "id");
                pack.worldName = Str(world, "name");
                pack.folder = folder;
                foreach (var c in List(world, "canon")) pack.canon.Add(c as string);
                var look = m["look"] as Dictionary<string, object>;
                pack.style = Str(look, "style");
                foreach (var hex in List(look, "palette")) if (ColorUtility.TryParseHtmlString(hex as string, out var col)) pack.palette.Add(col);
                pack.lut = Str(look.ContainsKey("grade") ? look["grade"] as Dictionary<string, object> : null, "lut");
                foreach (var c in List(m, "characters")) pack.characters.Add(MemberOf(c as Dictionary<string, object>, "model", folder));
                foreach (var p in List(m, "props")) pack.props.Add(MemberOf(p as Dictionary<string, object>, "model", folder));
                foreach (var p in List(m, "places"))
                {
                    var member = MemberOf(p as Dictionary<string, object>, "set", folder);
                    if (!string.IsNullOrEmpty(member.skybox)) member.skyboxMaterial = SkyboxFor(folder, member);
                    pack.places.Add(member);
                }
                var assetPath = folder + "/" + Safe(pack.worldName) + ".asset";
                AssetDatabase.CreateAsset(pack, assetPath);
                AssetDatabase.SaveAssets();
                Debug.Log($"Hawkes Gen: imported {pack.worldName} ({pack.characters.Count} characters, {pack.places.Count} places, {pack.props.Count} props) into {folder}");
                return pack;
            }
            finally
            {
                if (temp != null) try { Directory.Delete(temp, true); } catch { }
            }
        }

        static WorldPack.Member MemberOf(Dictionary<string, object> d, string modelKey, string folder)
        {
            var member = new WorldPack.Member { id = Str(d, "id"), name = Str(d, "name"), description = Str(d, "description"), skybox = Str(d, "skybox"), ambience = Str(d, "ambience") };
            // A character's FBX is preferred in Unity when there is one (its rig imports as Humanoid or Generic).
            member.model = !string.IsNullOrEmpty(Str(d, "fbx")) ? Str(d, "fbx") : Str(d, modelKey);
            foreach (var f in List(d, "files")) member.files.Add(f as string);
            return member;
        }

        static Material SkyboxFor(string folder, WorldPack.Member place)
        {
            var texPath = folder + "/" + place.skybox;
            var importer = AssetImporter.GetAtPath(texPath) as TextureImporter;
            if (importer != null)
            {
                importer.wrapModeU = TextureWrapMode.Repeat;
                importer.mipmapEnabled = false;
                importer.maxTextureSize = 8192;
                importer.SaveAndReimport();
            }
            var tex = AssetDatabase.LoadAssetAtPath<Texture2D>(texPath);
            var shader = Shader.Find("Skybox/Panoramic");
            if (tex == null || shader == null) return null;
            var mat = new Material(shader);
            mat.SetTexture("_MainTex", tex);
            AssetDatabase.CreateAsset(mat, Path.ChangeExtension(texPath, ".mat"));
            return mat;
        }

        static string Str(Dictionary<string, object> d, string k) => d != null && d.TryGetValue(k, out var v) && v != null ? v.ToString() : null;
        static List<object> List(Dictionary<string, object> d, string k) => d != null && d.TryGetValue(k, out var v) && v is List<object> l ? l : new List<object>();
        static string Safe(string s)
        {
            if (string.IsNullOrEmpty(s)) return "World";
            foreach (var c in Path.GetInvalidFileNameChars()) s = s.Replace(c, '-');
            return s.Trim();
        }
    }
}
