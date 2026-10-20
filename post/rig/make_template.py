"""Writes the Mixamo-shaped skeleton Make-It-Animatable reads as data/Mixamo/bones.fbx.

The published Mixamo dataset is gated, and the attention mask only needs each bone's parent
(joint index comes from the bone name). This builds those 52 bones, no leaf bones, in a T-pose.
Bone positions are placeholders: the model overwrites them from the mesh.

    python make_template.py /path/to/bones.fbx

Runs in the rig venv, which has bpy. Not Blender 5.
"""

import sys

import bpy

PREFIX = "mixamorig:"
# Child order is the usual Mixamo order. Parents must exist first.
PARENT = {
    "Spine": "Hips",
    "Spine1": "Spine",
    "Spine2": "Spine1",
    "Neck": "Spine2",
    "Head": "Neck",
    "LeftShoulder": "Spine2",
    "LeftArm": "LeftShoulder",
    "LeftForeArm": "LeftArm",
    "LeftHand": "LeftForeArm",
    "LeftHandThumb1": "LeftHand",
    "LeftHandThumb2": "LeftHandThumb1",
    "LeftHandThumb3": "LeftHandThumb2",
    "LeftHandIndex1": "LeftHand",
    "LeftHandIndex2": "LeftHandIndex1",
    "LeftHandIndex3": "LeftHandIndex2",
    "LeftHandMiddle1": "LeftHand",
    "LeftHandMiddle2": "LeftHandMiddle1",
    "LeftHandMiddle3": "LeftHandMiddle2",
    "LeftHandRing1": "LeftHand",
    "LeftHandRing2": "LeftHandRing1",
    "LeftHandRing3": "LeftHandRing2",
    "LeftHandPinky1": "LeftHand",
    "LeftHandPinky2": "LeftHandPinky1",
    "LeftHandPinky3": "LeftHandPinky2",
    "RightShoulder": "Spine2",
    "RightArm": "RightShoulder",
    "RightForeArm": "RightArm",
    "RightHand": "RightForeArm",
    "RightHandThumb1": "RightHand",
    "RightHandThumb2": "RightHandThumb1",
    "RightHandThumb3": "RightHandThumb2",
    "RightHandIndex1": "RightHand",
    "RightHandIndex2": "RightHandIndex1",
    "RightHandIndex3": "RightHandIndex2",
    "RightHandMiddle1": "RightHand",
    "RightHandMiddle2": "RightHandMiddle1",
    "RightHandMiddle3": "RightHandMiddle2",
    "RightHandRing1": "RightHand",
    "RightHandRing2": "RightHandRing1",
    "RightHandRing3": "RightHandRing2",
    "RightHandPinky1": "RightHand",
    "RightHandPinky2": "RightHandPinky1",
    "RightHandPinky3": "RightHandPinky2",
    "LeftUpLeg": "Hips",
    "LeftLeg": "LeftUpLeg",
    "LeftFoot": "LeftLeg",
    "LeftToeBase": "LeftFoot",
    "RightUpLeg": "Hips",
    "RightLeg": "RightUpLeg",
    "RightFoot": "RightLeg",
    "RightToeBase": "RightFoot",
}
ORDER = ["Hips", *PARENT.keys()]


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: python make_template.py bones.fbx")
    out = sys.argv[1]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    arm_data = bpy.data.armatures.new("Armature")
    arm = bpy.data.objects.new("Armature", arm_data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    eb = arm_data.edit_bones
    # T-pose, Z up, facing -Y. Positions only have to be a valid skeleton.
    place = {
        "Hips": ((0, 0, 1.0), (0, 0, 1.1)),
        "Spine": ((0, 0, 1.1), (0, 0, 1.25)),
        "Spine1": ((0, 0, 1.25), (0, 0, 1.4)),
        "Spine2": ((0, 0, 1.4), (0, 0, 1.55)),
        "Neck": ((0, 0, 1.55), (0, 0, 1.65)),
        "Head": ((0, 0, 1.65), (0, 0, 1.85)),
    }
    for side, sign in (("Left", 1), ("Right", -1)):
        place[f"{side}Shoulder"] = ((0.05 * sign, 0, 1.5), (0.15 * sign, 0, 1.5))
        place[f"{side}Arm"] = ((0.15 * sign, 0, 1.5), (0.4 * sign, 0, 1.5))
        place[f"{side}ForeArm"] = ((0.4 * sign, 0, 1.5), (0.65 * sign, 0, 1.5))
        place[f"{side}Hand"] = ((0.65 * sign, 0, 1.5), (0.75 * sign, 0, 1.5))
        place[f"{side}UpLeg"] = ((0.1 * sign, 0, 0.95), (0.1 * sign, 0, 0.5))
        place[f"{side}Leg"] = ((0.1 * sign, 0, 0.5), (0.1 * sign, 0, 0.08))
        place[f"{side}Foot"] = ((0.1 * sign, 0, 0.08), (0.1 * sign, -0.08, 0.02))
        place[f"{side}ToeBase"] = ((0.1 * sign, -0.08, 0.02), (0.1 * sign, -0.16, 0.02))
        for i, finger in enumerate(("Thumb", "Index", "Middle", "Ring", "Pinky")):
            y = -0.02 * i
            for n in (1, 2, 3):
                x0 = (0.75 + 0.03 * (n - 1)) * sign
                x1 = (0.75 + 0.03 * n) * sign
                place[f"{side}Hand{finger}{n}"] = ((x0, y, 1.5), (x1, y, 1.5))
    for name in ORDER:
        head, tail = place[name]
        b = eb.new(PREFIX + name)
        b.head = head
        b.tail = tail
        b.use_deform = True
        parent = PARENT.get(name)
        if parent:
            b.parent = eb[PREFIX + parent]
            b.use_connect = False
    if len(arm_data.edit_bones) != 52:
        sys.exit(f"expected 52 bones, got {len(arm_data.edit_bones)}")
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.export_scene.fbx(
        filepath=out, use_selection=False, object_types={"ARMATURE"}, add_leaf_bones=False,
        bake_anim=False, axis_forward="-Z", axis_up="Y", apply_unit_scale=True,
    )
    print(f"wrote {out} ({len(arm_data.bones)} bones)")


if __name__ == "__main__":
    main()
