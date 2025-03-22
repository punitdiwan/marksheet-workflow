const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const axios = require('axios');

// const outputDir = path.resolve(__dirname, 'output');
const localTemplatePath = path.resolve(__dirname, 'patrak.xlsx');
require('dotenv').config(); // Load environment variables from .env file
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

const outputFolder = path.join(__dirname, 'output');

// Function to fill the template with an array of objects
async function fillTemplate(valuesArray) {
    // Load the Excel file template
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(localTemplatePath);

    // Select the first worksheet
    const worksheet = workbook.worksheets[0];

    // Get the 18th row (headers) where the placeholders like {key1}, {key2} are defined
    const headerRow = worksheet.getRow(18);

    // Extract header values (ignoring the first element which is the row number in ExcelJS)
    const headers = headerRow.values.slice(1);

    // Start inserting data from row 19
    let rowIndex = 19;

    // Iterate over the valuesArray to insert data into the template
    valuesArray.forEach((values) => {
        // Select the row to insert data into (starting from row 19)
        const row = worksheet.getRow(rowIndex);

        // Iterate through the headers and match with the keys from the values object
        headers.forEach((header, colIndex) => {
            // Clean the header to match the key in the values object (remove curly braces)
            const key = header.replace(/[{}]/g, '');
            if (values.hasOwnProperty(key)) {
                // If the key exists in the values object, insert the corresponding value
                row.getCell(colIndex + 1).value = values[key];
            } else {
                // Otherwise, leave the cell blank
                row.getCell(colIndex + 1).value = null;
            }
        });

        // Increment row index for the next row
        rowIndex++;
    });
    // worksheet.spliceRows(18, 1); // This will remove the 18th row if you no longer need it

    // **Force Excel to Recalculate Formulas on Open**
    workbook.calcProperties.fullCalcOnLoad = true;

    // Save the updated Excel file after filling in the data
    const updatedFilePath = path.join(outputFolder, 'filled-patrak.xlsx');
    await workbook.xlsx.writeFile(updatedFilePath);
    console.log(`Template filled and saved as "${updatedFilePath}".`);
}

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

// Main function to execute the file moving and template filling
async function main() {
    try {

        await downloadTemplate(templateUrl, localTemplatePath);


        const valuesArray = await getMarks();
        console.log('Filling the template with data...', valuesArray);


        console.log('Filling the template...');
        await fillTemplate(valuesArray);

        console.log('Process completed successfully.');
    } catch (error) {
        console.error('Error during process:', error);
    }
}

main();