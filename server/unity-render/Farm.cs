// The render farm's batchmode entry point (Director/docs/render-farm.md). Lives in Director/farm/unity, OUTSIDE Assets,
// so J's editor never compiles it; worker.sh copies it into Assets/MusicVideo/Editor/Farm/ on the worker.
//
//   unity-editor -batchmode -projectPath <TKShock> -executeMethod TKShock.MV.EditorTools.Farm.Run
//
// Reads Director/gen/farm-job.json ({ video, w, h, fps, quality, shots: [{ id, hash, f0, f1 }] }), opens the video,
// builds it from its score (the scene and _Generated are never in the snapshot), has Node recompute every shot's hash on
// this very tree (tools/final.mjs --plan-json) and refuses any shot whose hash differs (same inputs or no render), then
// renders each shot frame by frame with Capture.At into ffmpeg, exactly as Transport.cs Render/Step do, into
// $HAWKES_FARM_RES/<id>-<hash>.mp4 with the sidecar tools/final.mjs expects. Exit 0 when every shot was written.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace TKShock.MV.EditorTools
{
    public static class Farm
    {
        static string Res => Environment.GetEnvironmentVariable("HAWKES_FARM_RES") ?? Path.Combine(Bridge.Root, "gen", "farm-res");
        static void Log(string s) => UnityEngine.Debug.Log("[farm] " + s);

        public static void Run()
        {
            int code = 1;
            try { code = Main(); }
            catch (Exception e) { Log("FAILED " + e); code = 2; }
            if (Application.isBatchMode) EditorApplication.Exit(code);
        }

        static int Main()
        {
            Directory.CreateDirectory(Res);
            Log($"batchMode={Application.isBatchMode} gfx={SystemInfo.graphicsDeviceType} device={SystemInfo.graphicsDeviceName} unity={Application.unityVersion}");
            if (SystemInfo.graphicsDeviceType == UnityEngine.Rendering.GraphicsDeviceType.Null) { Log("Null graphics device: this editor cannot render (started with -nographics?)"); return 3; }
            var job = JObject.Parse(File.ReadAllText(Path.Combine(Bridge.Root, "gen", "farm-job.json")));
            string video = (string)job["video"]; int w = (int)job["w"], h = (int)job["h"], fps = (int)job["fps"];
            string quality = (string)job["quality"] ?? "final";
            var shots = (JArray)job["shots"];

            // 1. Build from the score, the plain way (dead zones, bakes, save): what `mv build` does, in-process.
            Video.Use(video, true);
            var sw = Stopwatch.StartNew();
            var built = ScoreCompiler.BuildCommand(new JObject { ["fast"] = false }); // what `mv build` sends the Bridge: the plain build, saved
            Log($"built {video} in {sw.Elapsed.TotalSeconds:0} s: {(built == null ? "ok" : JToken.FromObject(built).ToString(Newtonsoft.Json.Formatting.None))}");
            if (File.Exists(Path.Combine(Application.dataPath, "..", "Library", ".farm-imported")) == false && Directory.Exists(Path.Combine(Application.dataPath, "..", "Library")))
                File.WriteAllText(Path.Combine(Application.dataPath, "..", "Library", ".farm-imported"), DateTime.UtcNow.ToString("o")); // worker.sh saves the cache when this is there

            // 2. The determinism gate: Node recomputes the shot hashes on this tree. A hash that differs means this tree is
            //    not what the coordinator planned from: that shot is skipped and reported, never rendered under a wrong name.
            var mine = PlanHashes(video, w, h, fps, quality);
            var todo = new List<JObject>();
            foreach (JObject s in shots)
            {
                string id = (string)s["id"], want = (string)s["hash"];
                if (!mine.TryGetValue(id, out var have)) { Log($"shot {id}: not in this tree's plan: skipped"); continue; }
                if (have != want) { Log($"shot {id}: hash here {have} differs from the plan's {want}: skipped (inputs differ)"); continue; }
                todo.Add(s);
            }
            Log($"{todo.Count} of {shots.Count} shots have matching hashes");

            // 3. Render each, Transport.cs's way: raw rgb24 frames down ffmpeg's stdin, exactly f1 - f0 frames.
            StartQuality(quality);
            int done = 0;
            foreach (var s in todo)
            {
                string id = (string)s["id"], hash = (string)s["hash"]; int f0 = (int)s["f0"], f1 = (int)s["f1"];
                string outPath = Path.Combine(Res, $"{id}-{hash}.mp4"), tmp = outPath + ".part.mp4";
                string enc = quality == "previs" ? "-preset ultrafast -crf 28" : quality == "draft" || quality == "preview" ? "-preset veryfast -crf 23" : "-preset medium -crf 17";
                var ff = Process.Start(new ProcessStartInfo("ffmpeg", $"-y -loglevel error -f rawvideo -pix_fmt rgb24 -s {w}x{h} -r {fps} -i - -vf vflip -c:v libx264 {enc} -pix_fmt yuv420p \"{tmp}\"")
                { UseShellExecute = false, RedirectStandardInput = true, CreateNoWindow = true });
                var stream = ff.StandardInput.BaseStream; var t = Stopwatch.StartNew();
                for (int i = f0; i < f1; i++) { var raw = Capture.At((double)i / fps, w, h); stream.Write(raw, 0, raw.Length); }
                ff.StandardInput.Close(); ff.WaitForExit();
                if (ff.ExitCode != 0) { Log($"shot {id}: ffmpeg failed"); continue; }
                File.Delete(outPath); File.Move(tmp, outPath);
                var side = new JObject { ["id"] = id, ["hash"] = hash, ["w"] = w, ["h"] = h, ["fps"] = fps, ["f0"] = f0, ["f1"] = f1, ["parts"] = s["parts"] ?? new JObject(),
                    ["rendered"] = DateTime.UtcNow.ToString("o"), ["where"] = $"farm {SystemInfo.graphicsDeviceType}/{SystemInfo.graphicsDeviceName}", ["seconds"] = Math.Round(t.Elapsed.TotalSeconds, 1) };
                File.WriteAllText(outPath.Replace(".mp4", ".json"), side.ToString());
                done++;
                Log($"shot {id}: {f1 - f0} frames in {t.Elapsed.TotalSeconds:0.0} s ({t.Elapsed.TotalSeconds / (f1 - f0):0.000} s/frame)");
            }
            EndQuality();
            Log($"rendered {done} of {todo.Count}");
            return done == todo.Count && todo.Count == shots.Count ? 0 : 4;
        }

        // What `node Director/tools/final.mjs <video> --plan-json` prints: [{ id, hash }] for this tree. (A small addition to
        // final.mjs: --plan-json writes the plan's ids and hashes as JSON and nothing else; see tools/farm.mjs.)
        static Dictionary<string, string> PlanHashes(string video, int w, int h, int fps, string quality)
        {
            var node = Process.Start(new ProcessStartInfo("node", $"\"{Path.Combine(Bridge.Root, "tools", "final.mjs")}\" {video} --w {w} --h {h} --fps {fps} --plan-json")
            { UseShellExecute = false, RedirectStandardOutput = true, CreateNoWindow = true, WorkingDirectory = Path.Combine(Bridge.Root, "..") });
            string text = node.StandardOutput.ReadToEnd(); node.WaitForExit();
            var map = new Dictionary<string, string>();
            foreach (JObject x in JArray.Parse(text)) map[(string)x["id"]] = (string)x["hash"];
            return map;
        }

        static void StartQuality(string q)
        {
            if (q == "previs") { Quality.Previs(true); Capture.ExtrasEvery = 4; }
            else if (q == "draft") Quality.Draft();
            else if (q == "preview") Quality.Set(true, 1);
            else Quality.Set(false);
        }
        static void EndQuality() { Capture.ExtrasEvery = 1; Quality.Previs(false); }
    }
}
