/**
 * Where the native layer copy puts its coordinate origin; y increases upward in both, and the visible PDF page is the same for either.
 *
 * - `'artboard-bottom-left'`: native coordinates equal the model's, with the origin at the artboard's lower-left corner, so native y runs from 0 to the artboard height and `%AI3_Cropmarks` is `0 0 W H`.
 * - `'artboard-top-left'`: the origin is at the artboard's upper-left corner, so native y runs from minus the artboard height to 0 and `%AI3_Cropmarks` is `0 −H W 0`.
 */
export type NativeOrigin = 'artboard-bottom-left' | 'artboard-top-left';
