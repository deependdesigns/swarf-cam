// Test model exercising every auto-detected operation type:
//   profile, drill, pocket, pocket+island, stepped pocket (tier-split),
//   through slot, slot-crossing-pocket (merge/demerge), edge-pocket, open-contour,
//   and a rotated single-exit slot crossing a complex (non-round, non-rectangular)
//   shape at a different depth (rotation + boundary-touch + tier-split combined)

blockX = 220;
blockY = 150;
blockZ = 14;

// 1. Drill — small through hole (<= tool diameter)
drillPos   = [25, 25];
drillDia   = 3.2;

// 2. Pocket with island — blind round pocket, boss standing in the middle
pocketIslandPos    = [75, 25];
pocketIslandDia    = 30;
pocketIslandFloorZ = 8;   // depth 6mm
islandDia          = 10;

// 3. Stepped pocket — wide shallow counterbore over a narrower deeper bore
stepPos       = [125, 25];
stepADia      = 20;
stepAFloorZ   = 10;  // counterbore depth 4mm
stepBDia      = 8;
stepBFloorZ   = 2;   // total depth 12mm, blind (2mm left on floor)

// 4. Through slot — open on both Y ends, splits the top outline in two
slotX      = 170;
slotWidth  = 20;

// 5. Slot crossing a pocket — merge/demerge test
crossPocketPos    = [75, 110];
crossPocketDia    = 30;
crossPocketFloorZ = 5;   // pocket depth 9mm, blind
crossSlotFloorZ   = 11;  // crossing channel depth 3mm — overlaps pocket near the top only

// 6. Edge pocket — concave notch cut into the X=0 edge
edgePocketPos    = [0, 130];
edgePocketRadius = 8;
edgePocketFloorZ = 10;   // depth 4mm

// 7. Open-contour — a bite taken out of the Y=150 edge, too big/shaped to be a plain slot
openContourPos    = [125, 135];
openContourWidth  = 30;
openContourDepth  = 14;  // stops 1mm short of the Y=150 edge — stays a closed void
                          // contour (within the boundary-proximity threshold) instead
                          // of literally puncturing the perimeter, which would just
                          // reshape the outer contour instead of creating a trackable void
openContourFloorZ = 9;   // depth 5mm, blind

// 8. Complex (3-arm asterisk) shape crossed by a rotated, single-exit slot — the two
// pieces sit at DIFFERENT depths, so they read as one merged open-contour void near the
// top (where the slot overlaps the shape and reaches the X=0 edge) and demerge into a
// plain enclosed complex pocket for the remainder of the shape's depth, once the shallow
// slot has bottomed out. Exercises rotation, single-sided boundary exit, and a
// classification change (open-contour -> pocket) across the tier split all at once.
blobPos        = [35, 70];
blobArmLength  = 40;
blobArmWidth   = 12;
blobFloorZ     = 6;   // total depth 8mm
slotPivot      = [0, 50];  // sits on the X=0 edge
slotAngle      = 30;       // degrees off the X axis
slotNearOffset = 4;   // local x start — leaves a ~1mm wall at the tightest rotated
                       // corner so this stays a closed void (within the boundary-
                       // proximity threshold) instead of literally breaching the X=0
                       // face, which would merge it into the outer contour and make it
                       // undetectable (same failure mode fixed for feature 7 above)
slotLength     = 55;
slotCutWidth   = 10;
slotFloorZ     = 11;  // crossing portion depth 3mm — shallower than the blob

module base() {
  difference() {
    cube([blockX, blockY, blockZ]);

    // 1. Drill
    translate([drillPos[0], drillPos[1], -1])
      cylinder(d = drillDia, h = blockZ + 2, $fn = 24);

    // 2. Pocket (island re-added via union below)
    translate([pocketIslandPos[0], pocketIslandPos[1], pocketIslandFloorZ])
      cylinder(d = pocketIslandDia, h = blockZ - pocketIslandFloorZ + 1, $fn = 48);

    // 3. Stepped pocket — counterbore tier
    translate([stepPos[0], stepPos[1], stepAFloorZ])
      cylinder(d = stepADia, h = blockZ - stepAFloorZ + 1, $fn = 48);
    // Stepped pocket — narrower deeper tier
    translate([stepPos[0], stepPos[1], stepBFloorZ])
      cylinder(d = stepBDia, h = blockZ - stepBFloorZ + 1, $fn = 32);

    // 4. Through slot (open both Y ends)
    translate([slotX, -1, -1])
      cube([slotWidth, blockY + 2, blockZ + 2]);

    // 5. Slot-crossing-pocket — the round pocket
    translate([crossPocketPos[0], crossPocketPos[1], crossPocketFloorZ])
      cylinder(d = crossPocketDia, h = blockZ - crossPocketFloorZ + 1, $fn = 48);
    // Slot-crossing-pocket — the shallow crossing channel
    translate([crossPocketPos[0] - 20, crossPocketPos[1] - 10, crossSlotFloorZ])
      cube([40, 20, blockZ - crossSlotFloorZ + 1]);

    // 6. Edge pocket — half-cylinder notch on the X=0 edge
    translate([edgePocketPos[0], edgePocketPos[1], edgePocketFloorZ])
      cylinder(r = edgePocketRadius, h = blockZ - edgePocketFloorZ + 1, $fn = 48);

    // 7. Open-contour — rectangular bite out of the Y=150 edge
    translate([openContourPos[0], openContourPos[1], openContourFloorZ])
      cube([openContourWidth, openContourDepth, blockZ - openContourFloorZ + 1]);

    // 8. Complex asterisk pocket (deeper tier)
    translate([blobPos[0], blobPos[1], 0])
      for (a = [0, 60, 120])
        rotate([0, 0, a])
          translate([-blobArmLength / 2, -blobArmWidth / 2, blobFloorZ])
            cube([blobArmLength, blobArmWidth, blockZ - blobFloorZ + 1]);

    // 8. Rotated single-exit slot crossing the asterisk (shallow tier, exits only at X=0)
    translate([slotPivot[0], slotPivot[1], 0])
      rotate([0, 0, slotAngle])
        translate([slotNearOffset, -slotCutWidth / 2, slotFloorZ])
          cube([slotLength, slotCutWidth, blockZ - slotFloorZ + 1]);
  }
}

union() {
  base();
  // Island boss standing inside the pocket from feature 2
  translate([pocketIslandPos[0], pocketIslandPos[1], pocketIslandFloorZ])
    cylinder(d = islandDia, h = blockZ - pocketIslandFloorZ, $fn = 32);
}
