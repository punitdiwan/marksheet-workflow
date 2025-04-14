const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const axios = require('axios');
require('dotenv').config();

const localTemplatePath = path.resolve(__dirname, 'patrak.xlsx');
const outputFolder = path.join(__dirname, 'output');
const templateUrl = process.env.TEMPLATE_URL;

// Ensure output folder exists
if (!fs.existsSync(outputFolder)) {
    fs.mkdirSync(outputFolder);
}

// Function to download the template file
const downloadTemplate = async (url, outputPath) => {
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        fs.writeFileSync(outputPath, response.data);
        console.log(`Template downloaded successfully to ${outputPath}`);
    } catch (error) {
        console.error('Error downloading template:', error);
        throw error;
    }
};

// Function to fetch student count data from API
async function getStudentCount(batchId, _school) {
    const payload = {
        _school: _school,
        batchId: batchId,
    };

    try {
        const fullUrl = `https://${_school}.edusparsh.com/api/cce_examv1/studentCount`;
        const studentResponse = await fetch(fullUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
        });

        if (!studentResponse.ok) {
            throw new Error(`Failed to fetch student count data for batch ${batchId}.`);
        }

        const studentData = await studentResponse.json();
        console.log(`Student count for batch ${batchId}:`, studentData);
        return studentData.data;
    } catch (error) {
        console.error(`Error fetching student count for batch ${batchId}:`, error);
        return { caste: {}, gender: {}, total: 0 }; // Fallback data
    }
}



// Function to fill both sheets with data for a single batch
async function fillTemplateForBatch(workbook, batchId, batchName, valuesArray, studentData, sheetOffset) {
    const sheet1 = workbook.worksheets[0];
    const headerRow1 = sheet1.getRow(18);
    const headers1 = headerRow1.values.slice(1);

    let rowIndex1 = 19 + sheetOffset; // Offset to avoid overwriting previous batch data
    let lastFilledRow1 = rowIndex1;

    valuesArray.forEach((values) => {
        const row = sheet1.getRow(rowIndex1);

        headers1.forEach((header, colIndex) => {
            const key = header.replace(/[{}]/g, '');

            if (values.hasOwnProperty(key)) {
                let cellValue = values[key];
                if (typeof cellValue === 'string' && cellValue.startsWith('=')) {
                    row.getCell(colIndex + 1).value = { formula: cellValue.substring(1) };
                } else {
                    row.getCell(colIndex + 1).value = cellValue ?? null;
                }
            } else {
                row.getCell(colIndex + 1).value = null;
            }
        });

        // Insert student count data for caste categories
        sheet1.getCell('AR2').value = studentData?.caste?.general?.total ?? 0;
        sheet1.getCell('AR3').value = studentData?.caste?.obc?.total ?? 0;
        sheet1.getCell('AR4').value = studentData?.caste?.st?.total ?? 0;
        sheet1.getCell('AR5').value = studentData?.caste?.sc?.total ?? 0;
        sheet1.getCell('AR6').value = studentData?.total ?? 0;

        // Insert student count data for gender
        sheet1.getCell('AU4').value = studentData?.gender?.male?.total ?? 0;
        sheet1.getCell('AU5').value = studentData?.gender?.female?.total ?? 0;
        sheet1.getCell('AU6').value = studentData?.total ?? 0;

        row.commit();
        lastFilledRow1 = rowIndex1;
        rowIndex1++;
    });

    return lastFilledRow1; // Return the last row filled for offset calculation
}

// Function to process multiple batches
async function fillTemplate(valuesArrayByBatch, studentDataByBatch) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(localTemplatePath);

    let sheetOffset = 0;

    for (const batch of valuesArrayByBatch) {
        const lastRow = await fillTemplateForBatch(
            workbook,
            batch.batchId,
            batch.batchName,
            batch.data,
            studentDataByBatch[batch.batchId],
            sheetOffset
        );
        sheetOffset = lastRow - 18; // Update offset for next batch
    }

    const sheet1 = workbook.worksheets[0];
    sheet1.getRow(18).hidden = true;
    sheet1.spliceRows(sheetOffset + 19, 100);
    console.log(`Sheet 1: Deleted 100 rows starting from row ${sheetOffset + 19}.`);

    // /** ✨ Process Second Sheet **/
    // const sheet2 = workbook.worksheets[1]; // Second sheet
    // const headerRow2 = sheet2.getRow(7); // Header row
    // const headers2 = headerRow2.values.slice(1);

    // let rowIndex2 = 8; // Start inserting from row 8
    // let lastFilledRow2 = rowIndex2;

    // valuesArray.forEach((values) => {
    //     const row = sheet2.getRow(rowIndex2);

    //     headers2.forEach((header, colIndex) => {
    //         const key = header.replace(/[{}]/g, '');

    //         if (values.hasOwnProperty(key)) {
    //             let cellValue = values[key];

    //             if (typeof cellValue === 'string' && cellValue.startsWith('=')) {
    //                 row.getCell(colIndex + 1).value = { formula: cellValue.substring(1) };
    //             } else {
    //                 row.getCell(colIndex + 1).value = cellValue ?? null;
    //             }
    //         } else {
    //             row.getCell(colIndex + 1).value = null;
    //         }
    //     });

    //     row.commit();
    //     lastFilledRow2 = rowIndex2;
    //     rowIndex2++;
    // });

    // // Delete row 7 (headers) after inserting data
    // sheet2.spliceRows(7, 1);
    // console.log(`Sheet 2: Deleted row 7.`);

    //     /** ✨ Force Excel to Recalculate Formulas on Open **/
    workbook.calcProperties.calcMode = 'auto';
    workbook.calcProperties.fullCalcOnLoad = true;
    workbook.calcProperties.calcOnSave = true;


    sheet1.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber >= 19) {
            row.eachCell((cell) => {
                if (cell.formula) {
                    cell.value = { formula: cell.formula, result: null };
                }
            });
        }
    });

    const updatedFilePath = path.join(outputFolder, 'filled-patrak.xlsx');
    await workbook.xlsx.writeFile(updatedFilePath);
    console.log(`Template filled and saved as "${updatedFilePath}".`);
}

// Main function to execute the process
// Function to fetch marks from API
async function getMarks(batchId, groupIds, _school, rankingId, divisionId, apiUrl) {
    const group = groupIds.split(',');

    const data = {
        _school: _school,
        batchId: batchId,
        group: group,
        currentdata: {
            division_id: divisionId,
            ranking_id: rankingId,
        },
    };

    try {
        const response = await axios.post(apiUrl, data);
        console.log(`Marks fetched for batch ${batchId}`);
        return response.data.data;
    } catch (error) {
        console.error(`Error fetching marks for batch ${batchId}:`, error);
        return [];
    }
}
async function main() {
    try {
        await downloadTemplate(templateUrl, localTemplatePath);

        const batchIds = process.env.BATCH_ID.split(',');
        const groupIds = process.env.GROUP_ID;
        const _school = process.env.SCHOOL_ID;
        const rankingId = process.env.RANKING_ID;
        const divisionId = process.env.DIVISION_ID;
        const apiUrl = process.env.API_URL;

        if (!batchIds || !_school || !groupIds || !apiUrl) {
            throw new Error('Required environment variables are missing.');
        }

        const valuesArrayByBatch = [];
        const studentDataByBatch = {};

        // Fetch data for each batch sequentially
        for (const batchId of batchIds) {
            const marks = await getMarks(batchId, groupIds, _school, rankingId, divisionId, apiUrl);
            const studentData = await getStudentCount(batchId, _school);
            valuesArrayByBatch.push({
                batchId,
                batchName: `Batch_${batchId}`, // Replace with actual batch name if available
                data: marks,
            });
            studentDataByBatch[batchId] = studentData;
        }

        await fillTemplate(valuesArrayByBatch, studentDataByBatch);
        console.log('Process completed successfully.');
    } catch (error) {
        console.error('Error during process:', error);
    }
}

main();