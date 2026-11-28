// RFC 1321, 3 processes padded input in 512-bit blocks with four rounds of 32-bit operations.
const SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16,
  23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const CONSTANTS = [
  0xd7_6a_a4_78, 0xe8_c7_b7_56, 0x24_20_70_db, 0xc1_bd_ce_ee, 0xf5_7c_0f_af, 0x47_87_c6_2a, 0xa8_30_46_13, 0xfd_46_95_01, 0x69_80_98_d8, 0x8b_44_f7_af,
  0xff_ff_5b_b1, 0x89_5c_d7_be, 0x6b_90_11_22, 0xfd_98_71_93, 0xa6_79_43_8e, 0x49_b4_08_21, 0xf6_1e_25_62, 0xc0_40_b3_40, 0x26_5e_5a_51, 0xe9_b6_c7_aa,
  0xd6_2f_10_5d, 0x02_44_14_53, 0xd8_a1_e6_81, 0xe7_d3_fb_c8, 0x21_e1_cd_e6, 0xc3_37_07_d6, 0xf4_d5_0d_87, 0x45_5a_14_ed, 0xa9_e3_e9_05, 0xfc_ef_a3_f8,
  0x67_6f_02_d9, 0x8d_2a_4c_8a, 0xff_fa_39_42, 0x87_71_f6_81, 0x6d_9d_61_22, 0xfd_e5_38_0c, 0xa4_be_ea_44, 0x4b_de_cf_a9, 0xf6_bb_4b_60, 0xbe_bf_bc_70,
  0x28_9b_7e_c6, 0xea_a1_27_fa, 0xd4_ef_30_85, 0x04_88_1d_05, 0xd9_d4_d0_39, 0xe6_db_99_e5, 0x1f_a2_7c_f8, 0xc4_ac_56_65, 0xf4_29_22_44, 0x43_2a_ff_97,
  0xab_94_23_a7, 0xfc_93_a0_39, 0x65_5b_59_c3, 0x8f_0c_cc_92, 0xff_ef_f4_7d, 0x85_84_5d_d1, 0x6f_a8_7e_4f, 0xfe_2c_e6_e0, 0xa3_01_43_14, 0x4e_08_11_a1,
  0xf7_53_7e_82, 0xbd_3a_f2_35, 0x2a_d7_d2_bb, 0xeb_86_d3_91,
];

export interface Md5 {
  update: (bytes: Uint8Array) => Md5;
  digest: () => Uint8Array;
}

// RFC 1321, 3.3 initializes the four-word buffer; 3.4 processes each 16-word block with four rounds.
const processBlocks = (state: Uint32Array, view: DataView, end: number): void => {
  let stateA = state[0] ?? 0;
  let stateB = state[1] ?? 0;
  let stateC = state[2] ?? 0;
  let stateD = state[3] ?? 0;
  for (let block = 0; block < end; block += 64) {
    let a = stateA;
    let b = stateB;
    let c = stateC;
    let d = stateD;
    for (let step = 0; step < 64; step++) {
      let combined = (b & c) | (~b & d);
      let wordIndex = step;
      if (step >= 16 && step < 32) {
        combined = (d & b) | (~d & c);
        wordIndex = (5 * step + 1) % 16;
      } else if (step >= 32 && step < 48) {
        combined = b ^ c ^ d;
        wordIndex = (3 * step + 5) % 16;
      } else if (step >= 48) {
        combined = c ^ (b | ~d);
        wordIndex = (7 * step) % 16;
      }
      const shift = SHIFTS[step] ?? 0;
      const sum = (a + combined + view.getUint32(block + wordIndex * 4, true) + (CONSTANTS[step] ?? 0)) >>> 0;
      const rotated = (sum << shift) | (sum >>> (32 - shift));
      a = d;
      d = c;
      c = b;
      b = (b + rotated) >>> 0;
    }
    stateA = (stateA + a) >>> 0;
    stateB = (stateB + b) >>> 0;
    stateC = (stateC + c) >>> 0;
    stateD = (stateD + d) >>> 0;
  }
  state.set([stateA, stateB, stateC, stateD]);
};

// Hashes input supplied in any number of pieces, holding at most one partial 64-byte block between calls.
export const createMd5 = (): Md5 => {
  const state = Uint32Array.of(0x67_45_23_01, 0xef_cd_ab_89, 0x98_ba_dc_fe, 0x10_32_54_76);
  const pending = new Uint8Array(64);
  const pendingView = new DataView(pending.buffer);
  let pendingLength = 0;
  let totalLength = 0;
  const hash: Md5 = {
    update: bytes => {
      totalLength += bytes.length;
      let offset = 0;
      if (pendingLength > 0) {
        offset = Math.min(64 - pendingLength, bytes.length);
        pending.set(bytes.subarray(0, offset), pendingLength);
        pendingLength += offset;
        if (pendingLength < 64) {
          return hash;
        }
        processBlocks(state, pendingView, 64);
        pendingLength = 0;
      }
      const whole = Math.floor((bytes.length - offset) / 64) * 64;
      if (whole > 0) {
        processBlocks(state, new DataView(bytes.buffer, bytes.byteOffset + offset, whole), whole);
      }
      pending.set(bytes.subarray(offset + whole));
      pendingLength = bytes.length - offset - whole;
      return hash;
    },
    digest: () => {
      // RFC 1321, 3.1 and 3.2 append a one bit, zeros to 56 bytes modulo 64, then the 64-bit bit length in little-endian order.
      const final = new Uint8Array(pendingLength < 56 ? 64 : 128);
      final.set(pending.subarray(0, pendingLength));
      final[pendingLength] = 0x80;
      const view = new DataView(final.buffer);
      view.setUint32(final.length - 8, (totalLength % 0x20_00_00_00) * 8, true);
      view.setUint32(final.length - 4, Math.floor(totalLength / 0x20_00_00_00), true);
      const finalState = Uint32Array.from(state);
      processBlocks(finalState, view, final.length);
      const result = new Uint8Array(16);
      const output = new DataView(result.buffer);
      for (let word = 0; word < 4; word++) {
        output.setUint32(word * 4, finalState[word] ?? 0, true);
      }
      return result;
    },
  };
  return hash;
};

/** Returns the 16-byte MD5 digest of the input bytes. */
export const md5 = (data: Uint8Array): Uint8Array => createMd5().update(data).digest();
