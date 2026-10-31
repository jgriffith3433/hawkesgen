// A Hawkes Gen world pack as an asset in the project (WorldPackImporter makes it): the world's characters, places,
// props and look, with their files under the pack's folder. Its own file: Unity needs a ScriptableObject's file to
// carry its name.

using System.Collections.Generic;
using UnityEngine;

namespace HawkesGen
{
    /// <summary>A world as the pack describes it, kept in the project beside its files.</summary>
    public class WorldPack : ScriptableObject
    {
        [System.Serializable]
        public class Member
        {
            public string id;
            public string name;
            [TextArea] public string description;
            /// <summary>The model (GLB, or FBX when there is one), relative to the pack folder.</summary>
            public string model;
            public string skybox;
            public string ambience;
            public List<string> files = new List<string>();
            public Material skyboxMaterial;
        }

        public string worldId;
        public string worldName;
        public List<string> canon = new List<string>();
        public string style;
        public List<Color> palette = new List<Color>();
        public string lut;
        public List<Member> characters = new List<Member>();
        public List<Member> places = new List<Member>();
        public List<Member> props = new List<Member>();
        /// <summary>The pack folder under Assets.</summary>
        public string folder;
    }
}
