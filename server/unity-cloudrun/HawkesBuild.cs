// Hawkes Gen's default build method for customer builds (docs/unity-cloudrun.md, "Customer mode"). The container copies
// this into the checkout (Assets/HawkesGenCloud/Editor/, with an Editor-only asmdef) only when the build names no
// method of its own, then runs -executeMethod HawkesGenCloud.HawkesBuild.Build. It is never committed anywhere.
//
// Every enabled scene in File > Build Settings (EditorBuildSettings) is built to WebGL into the folder in env HAWKES_OUT,
// with compression off: the build is served from static hosts that can't send Content-Encoding.
#if UNITY_EDITOR
using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEngine;

namespace HawkesGenCloud
{
    public static class HawkesBuild
    {
        public static void Build()
        {
            var outDir = Environment.GetEnvironmentVariable("HAWKES_OUT");
            if (string.IsNullOrEmpty(outDir))
            {
                Debug.LogError("[Hawkes] build failed: HAWKES_OUT is not set");
                EditorApplication.Exit(2);
                return;
            }
            var scenes = EditorBuildSettings.scenes.Where(s => s.enabled && !string.IsNullOrEmpty(s.path)).Select(s => s.path).ToArray();
            if (scenes.Length == 0)
            {
                Debug.LogError("[Hawkes] build failed: no enabled scenes in File > Build Settings (add the game's scenes there, or name a build method)");
                EditorApplication.Exit(3);
                return;
            }
            PlayerSettings.WebGL.compressionFormat = WebGLCompressionFormat.Disabled;
            PlayerSettings.WebGL.decompressionFallback = false;
            Directory.CreateDirectory(outDir);
            Debug.Log($"[Hawkes] building {scenes.Length} scene(s) to WebGL: {string.Join(", ", scenes)}");
            var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
            {
                scenes = scenes,
                locationPathName = outDir,
                target = BuildTarget.WebGL,
                options = BuildOptions.None,
            });
            var summary = report.summary;
            if (summary.result != BuildResult.Succeeded)
            {
                Debug.LogError($"[Hawkes] build failed: {summary.result}, {summary.totalErrors} error(s)");
                EditorApplication.Exit(1);
                return;
            }
            Debug.Log($"[Hawkes] built {scenes.Length} scene(s) in {summary.totalTime.TotalSeconds:0}s, {summary.totalSize} bytes");
            EditorApplication.Exit(0);
        }
    }
}
#endif
