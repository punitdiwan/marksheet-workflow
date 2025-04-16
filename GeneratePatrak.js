const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const axios = require('axios');
require('dotenv').config();

const localTemplatePath = path.resolve(__dirname, 'patrak.xlsx');
const outputFolder = path.join(__dirname, 'output');
const templateUrl = process.env.TEMPLATE_URL;

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
async function getStudentCount(batchId) {
    const _school = process.env.SCHOOL_ID;

    if (!_school) {
        throw new Error('SCHOOL_ID is not defined in the environment variables.');
    }

    const payload = {
        "_school": _school,
        "batchId": batchId
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
        console.log(`Student data count for batch ${batchId}:`, studentData);
        return studentData.data;
    } catch (error) {
        console.error(`Error fetching student count for batch ${batchId}:`, error);
        throw error;
    }
}

// Function to fetch marks from API
async function getMarks(batchId) {
    const groupid = process.env.GROUP_ID;
    const _school = process.env.SCHOOL_ID;
    const RANKING_ID = process.env.RANKING_ID;
    const DIVISION_ID = process.env.DIVISION_ID;
    const API_URL = process.env.API_URL;
    const group = groupid?.split(",");
    const url = API_URL;

    const data = {
        "_school": _school,
        "batchId": batchId,
        "group": group,
        "currentdata": {
            "division_id": DIVISION_ID,
            "ranking_id": RANKING_ID
        }
    };

    try {
        const response = await axios.post(url, data);
        return response.data.data;
    } catch (error) {
        console.error(`Error making POST request for batch ${batchId}:`, error);
        throw error;
    }
}

// Function to fill both sheets with data
async function fillTemplate(valuesArray, studentDataMap) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(localTemplatePath);

    // ✨ Process First Sheet (Main Sheet)
    const sheet1 = workbook.worksheets[0]; // First sheet
    const headerRow1 = sheet1.getRow(18); // Header row
    // const headers1 = headerRow1.values.slice(1).map(header => {
    //     // Ensure headers are strings
    //     return typeof header === 'string' ? header : (header.text || '');
    // });

    const headers1 = headerRow1?.values.slice(1);

    let rowIndex1 = 19;
    let lastFilledRow1 = rowIndex1;

    // Fill the row with data
    valuesArray.forEach((values) => {
        const row = sheet1.getRow(rowIndex1);

        headers1.forEach((header, colIndex) => {
            const key = header.replace(/[{}]/g, '');

            if (values.hasOwnProperty(key)) {
                let cellValue = values[key];

                // If value is a formula (e.g., "=K19/4"), store as formula
                if (typeof cellValue === 'string' && cellValue.startsWith('=')) {
                    row.getCell(colIndex + 1).value = { formula: cellValue.substring(1) };
                } else {
                    row.getCell(colIndex + 1).value = cellValue ?? null;
                }
            } else {
                row.getCell(colIndex + 1).value = null;
            }
        });

        // Insert student count data for the first batch
        const firstBatchId = Object.keys(studentDataMap)[0];
        const studentData = studentDataMap[firstBatchId];
        sheet1.getCell('AR2').value = studentData?.caste?.general?.total ?? 0;
        sheet1.getCell('AR3').value = studentData?.caste?.obc?.total ?? 0;
        sheet1.getCell('AR4').value = studentData?.caste?.st?.total ?? 0;
        sheet1.getCell('AR5').value = studentData?.caste?.sc?.total ?? 0;
        sheet1.getCell('AR6').value = studentData?.total ?? 0;

        sheet1.getCell('AU4').value = studentData?.gender?.male?.total ?? 0;
        sheet1.getCell('AU5').value = studentData?.gender?.female?.total ?? 0;
        sheet1.getCell('AU6').value = studentData?.total ?? 0;

        row.commit();
        lastFilledRow1 = rowIndex1;
        rowIndex1++;
    });


    // After filling the template, write to the file
    sheet1.getRow(18).hidden = true;
    sheet1.spliceRows(lastFilledRow1 + 1, 100);
    console.log(`Sheet 1: Deleted 100 rows starting from row ${lastFilledRow1 + 1}.`);

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
    /** ✨ Force Excel to Recalculate Formulas on Open **/
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
async function main() {
    try {
        await downloadTemplate(templateUrl, localTemplatePath);

        const batchIds = process.env.BATCH_ID.split(',');
        let allValuesArray = [];
        let studentDataMap = {};

        // Fetch marks and student count for each batch
        for (const batchId of batchIds) {
            console.log(`Processing batch ${batchId}...`);
            const batchMarks = await getMarks(batchId);
            allValuesArray = allValuesArray.concat(batchMarks);
            const batchStudentData = await getStudentCount(batchId);
            studentDataMap[batchId] = batchStudentData;
        }

        console.log('Filling the template with data from all batches...');
        await fillTemplate(allValuesArray, studentDataMap);
        console.log('Process completed successfully.');
    } catch (error) {
        console.error('Error during process:', error);
    }
}

main();