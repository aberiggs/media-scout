import { z } from 'zod';
import { Http, type QueryParams } from '../http';

const QUEUE_PAGE_SIZE = 100;
const MAX_QUEUE_PAGES = 100;

/** Reads an Arr queue completely or rejects; a partial prefix must never look empty/complete. */
export async function getAllQueueRecords<T>(
  http: Http,
  args: {
    path: string;
    params: QueryParams;
    schema: z.ZodType<{
      page: number;
      pageSize: number;
      totalRecords: number;
      records: T[];
    }>;
  },
): Promise<T[]> {
  const records: T[] = [];
  const rowIds = new Set<number>();
  let expectedTotal: number | undefined;

  for (let page = 1; page <= MAX_QUEUE_PAGES; page += 1) {
    const response = args.schema.parse(
      await http.getJson(args.path, { ...args.params, page, pageSize: QUEUE_PAGE_SIZE }),
    );
    if (response.page !== page) {
      throw new Error(`Arr queue returned page ${response.page}; expected page ${page}`);
    }
    if (response.pageSize !== QUEUE_PAGE_SIZE) {
      throw new Error(`Arr queue returned pageSize ${response.pageSize}; expected ${QUEUE_PAGE_SIZE}`);
    }
    if (response.records.length > QUEUE_PAGE_SIZE) {
      throw new Error(`Arr queue returned more than the requested ${QUEUE_PAGE_SIZE} records on one page`);
    }
    if (expectedTotal === undefined) {
      expectedTotal = response.totalRecords;
    } else if (response.totalRecords !== expectedTotal) {
      throw new Error('Arr queue totalRecords changed during pagination');
    }

    const nextRecordCount = records.length + response.records.length;
    if (nextRecordCount > expectedTotal) {
      throw new Error('Arr queue returned more records than totalRecords');
    }
    if (response.records.length === 0 && records.length < expectedTotal) {
      throw new Error('Arr queue returned an empty page before totalRecords were collected');
    }

    for (const record of response.records) {
      if (record !== null && typeof record === 'object' && 'id' in record) {
        const id = (record as { id?: unknown }).id;
        if (typeof id === 'number') {
          if (rowIds.has(id)) throw new Error('Arr queue repeated a row ID during pagination');
          rowIds.add(id);
        }
      }
    }
    records.push(...response.records);

    if (records.length === expectedTotal) return records;
  }

  throw new Error(`Arr queue pagination exceeded the ${MAX_QUEUE_PAGES}-page safety bound`);
}
