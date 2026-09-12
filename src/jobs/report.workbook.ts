import { Workbook } from 'exceljs';

export interface ReportColumn<TRow> {
    header: string;
    key: keyof TRow & string;
    width: number;
}

export const REPORT_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** The one `.xlsx` shape the report jobs send: a bold header row over plain rows. */
export async function buildReportWorkbook<TRow>(
    sheetName: string,
    columns: ReportColumn<TRow>[],
    rows: TRow[],
): Promise<Buffer> {
    const workbook = new Workbook();
    const sheet = workbook.addWorksheet(sheetName);
    sheet.columns = [...columns];
    sheet.getRow(1).font = { bold: true, size: 14 };

    for (const row of rows) sheet.addRow(row);

    return Buffer.from(await workbook.xlsx.writeBuffer());
}
