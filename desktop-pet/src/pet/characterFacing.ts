export type FacingDirection = "left" | "right";

export function shouldMirrorForFacingDirection(
  skin: string,
  direction: FacingDirection,
): boolean {
  const skinDirection: FacingDirection = skin === "朝右" ? "right" : "left";
  return skinDirection !== direction;
}
