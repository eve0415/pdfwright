// Builds large print-like files for memory and throughput tests.

const encoder = new TextEncoder();

// A print-like file: pages that each place a large uncompressed image, written with a classic cross-reference table.
export const largeFile = (pages: number, imageBytes: number): Uint8Array => {
  const parts: Uint8Array[] = [encoder.encode('%PDF-1.7\n')];
  const offsets: number[] = [];
  let length = parts[0]?.length ?? 0;
  const add = (number: number, head: string, data?: Uint8Array): void => {
    offsets[number] = length;
    const pieces =
      data === undefined
        ? [encoder.encode(`${String(number)} 0 obj\n${head}\nendobj\n`)]
        : [encoder.encode(`${String(number)} 0 obj\n${head}\nstream\n`), data, encoder.encode('\nendstream\nendobj\n')];
    for (const piece of pieces) {
      parts.push(piece);
      length += piece.length;
    }
  };
  const kids = Array.from({ length: pages }, (_, index) => `${String(3 + index * 3)} 0 R`).join(' ');
  add(1, '<</Type/Catalog/Pages 2 0 R>>');
  add(2, `<</Type/Pages/Kids[${kids}]/Count ${String(pages)}/MediaBox[0 0 612 792]>>`);
  const image = new Uint8Array(imageBytes).fill(0x80);
  for (let index = 0; index < pages; index++) {
    const page = 3 + index * 3;
    add(page, `<</Type/Page/Parent 2 0 R/Contents ${String(page + 1)} 0 R/Resources<</XObject<</Im1 ${String(page + 2)} 0 R>>>>>>`);
    const content = encoder.encode('q 612 0 0 792 0 0 cm /Im1 Do Q');
    add(page + 1, `<</Length ${String(content.length)}>>`, content);
    add(
      page + 2,
      `<</Type/XObject/Subtype/Image/Width ${String(imageBytes)}/Height 1/ColorSpace/DeviceGray/BitsPerComponent 8/Length ${String(imageBytes)}>>`,
      image,
    );
  }
  const size = 3 + pages * 3;
  let table = `xref\n0 ${String(size)}\n0000000000 65535 f \n`;
  for (let number = 1; number < size; number++) table += `${String(offsets[number] ?? 0).padStart(10, '0')} 00000 n \n`;
  parts.push(encoder.encode(`${table}trailer\n<</Size ${String(size)}/Root 1 0 R>>\nstartxref\n${String(length)}\n%%EOF\n`));
  const file = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    file.set(part, offset);
    offset += part.length;
  }
  return file;
};
