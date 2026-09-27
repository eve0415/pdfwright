import type { ContentBuilder } from './contentBuilder.ts';
import type { GroupOptions, PdfGroup } from './group.ts';
import type { ImageOptions, ImageRecord, PdfImage } from './image.ts';
import type { PieceInfoInput } from './pieceInfo.ts';
import type { DocumentRecords, GroupRecord } from './resourceRecord.ts';
import type { Separation, SeparationOptions } from './separation.ts';

import { ValidationError } from '../error/validationError.ts';

import { createContentBuilder } from './contentBuilder.ts';
import { groupAttributes } from './group.ts';
import { createImageRecord } from './image.ts';
import { pieceInfoRecord } from './pieceInfo.ts';
import { createContentHooks, createResourceRecord, groupRecord, separationRecord } from './resourceRecord.ts';
import { colorantKey, createSeparationRecord } from './separation.ts';

export interface HandleOptions {
  readonly fractionDigits: number;
  readonly asciiOnlyColorants: boolean;
}

/** The separations, images and groups a document creates, behind opaque handles that only this document accepts. */
export interface DocumentHandles {
  readonly records: DocumentRecords;
  /** Images and groups in creation order. */
  readonly images: readonly ImageRecord[];
  readonly groups: readonly GroupRecord[];
  separation: (options: SeparationOptions) => Separation;
  image: (options: ImageOptions) => PdfImage;
  group: (options: GroupOptions, render: (content: ContentBuilder) => void) => PdfGroup;
}

export const createDocumentHandles = (options: HandleOptions): DocumentHandles => {
  const documentSeparations = new Map<string, Separation>();
  const images: ImageRecord[] = [];
  const groups: GroupRecord[] = [];
  const records: DocumentRecords = { separations: new WeakMap(), images: new WeakMap(), groups: new WeakMap() };
  const { fractionDigits } = options;
  return {
    records,
    images,
    groups,
    group: (groupOptions, render): PdfGroup => {
      const attributes = groupAttributes(groupOptions, fractionDigits);
      const handle: PdfGroup = Object.freeze({
        kind: 'PdfGroup',
        pieceInfo: (input: PieceInfoInput): void => {
          groupRecord(records, handle).pieceInfo = pieceInfoRecord(input.lastModified, input.data);
        },
      });
      const resources = createResourceRecord();
      // ISO 32000-1:2008, 11.6.6, Table 147, CS: "Default value: the colour space of the parent group or page into which this transparency group is painted."
      const hooks = createContentHooks(resources, records, { blendingSpace: attributes.colorSpace ?? 'inherited' });
      // A group is drawn only through a page, so its content always starts inside the page's isolating q, the placement's q and the save made by Do (ISO 32000-1:2008, 8.10.1).
      hooks.maxDepth = 25;
      hooks.inheritsState = true;
      const session = createContentBuilder(fractionDigits, hooks);
      render(session.content);
      const { data, summary } = session.finish();
      const record: GroupRecord = { attributes, content: data, summary, ...resources };
      records.groups.set(handle, record);
      groups.push(record);
      return handle;
    },
    image: (imageOptions): PdfImage => {
      const record = createImageRecord(imageOptions, separation => separationRecord(records, separation));
      const handle: PdfImage = Object.freeze({ kind: 'PdfImage' });
      records.images.set(handle, record);
      images.push(record);
      return handle;
    },
    separation: (separationOptions): Separation => {
      const record = createSeparationRecord(separationOptions, options.asciiOnlyColorants);
      const key = colorantKey(record.name);
      const existing = documentSeparations.get(key);
      if (existing !== undefined) {
        if (JSON.stringify(separationRecord(records, existing).alternate) !== JSON.stringify(record.alternate)) {
          throw new ValidationError('the same colorant name cannot use conflicting alternate colours');
        }
        return existing;
      }
      const handle: Separation = Object.freeze({ kind: 'Separation' });
      records.separations.set(handle, record);
      documentSeparations.set(key, handle);
      return handle;
    },
  };
};
