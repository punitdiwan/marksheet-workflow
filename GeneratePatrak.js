const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const axios = require('axios');
require('dotenv').config(); // Load environment variables

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

// Function to fill the template with data and formulas
async function fillTemplate(valuesArray) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(localTemplatePath);
    const worksheet = workbook.worksheets[0];

    // Read the 18th row (header row)
    const headerRow = worksheet.getRow(18);
    const headers = headerRow.values.slice(1); // Extract headers (skip row number)

    let rowIndex = 19; // Start inserting data from row 19
    let lastFilledRow = rowIndex; // Track last filled row

    valuesArray.forEach((values) => {
        const row = worksheet.getRow(rowIndex);

        headers.forEach((header, colIndex) => {
            const key = header.replace(/[{}]/g, ''); // Clean header key

            if (values.hasOwnProperty(key)) {
                let cellValue = values[key];

                // If the value is a formula (e.g., "=K19/4"), set it as a formula
                if (typeof cellValue === 'string' && cellValue.startsWith('=')) {
                    row.getCell(colIndex + 1).value = { formula: cellValue.substring(1) };
                } else {
                    row.getCell(colIndex + 1).value = cellValue ?? null; // Insert value or null
                }
            } else {
                row.getCell(colIndex + 1).value = null; // Leave empty if no matching key
            }
        });

        row.commit(); // Save row changes
        lastFilledRow = rowIndex; // Update last filled row
        rowIndex++;
    });

    // worksheet.spliceRows(18, 1); // Remove the 18th row (headers) if no longer needed

    // **Delete the next 50 rows after the last filled row**
    worksheet.spliceRows(lastFilledRow + 1, 50);
    console.log(`Deleted 50 rows starting from row ${lastFilledRow + 1}.`);

    // **Force Excel to Recalculate Formulas on Open**
    workbook.calcProperties.fullCalcOnLoad = true;

    // Save the updated file
    const updatedFilePath = path.join(outputFolder, 'filled-patrak.xlsx');
    await workbook.xlsx.writeFile(updatedFilePath);
    console.log(`Template filled and saved as "${updatedFilePath}".`);
}

// Function to fetch marks from API
async function getMarks() {
    const groupid = process.env.GROUP_ID;
    const batchId = process.env.BATCH_ID;
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
        // Make the POST request
        const response = await axios.post(url, data);

        // Handle the response
        return response.data.data;
    } catch (error) {
        // Handle error
        console.error('Error making POST request:', error);
    }
}

// Main function to execute the process
async function main() {
    try {
        await downloadTemplate(templateUrl, localTemplatePath);
        const valuesArray = await getMarks();
        console.log('Filling the template with data...', valuesArray);
        await fillTemplate(valuesArray);
        console.log('Process completed successfully.');
    } catch (error) {
        console.error('Error during process:', error);
    }
}

main();