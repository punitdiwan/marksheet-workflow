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


// const localFilePath = path.join(__dirname, 'patrak.xlsx');
const outputFolder = path.join(__dirname, 'output');
// const downloadedFilePath = path.join(outputFolder, 'patrak.xlsx');

// Function to fill the template with an array of objects
async function fillTemplate(valuesArray) {
    if (!valuesArray || valuesArray.length === 0) {
        console.error('No values provided to fill the template');
        return;
    }
    // Load the Excel file template
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(localTemplatePath);

    // Select the first worksheet
    const worksheet = workbook.worksheets[0];

    // Get the 18th row (headers) where the placeholders like {key1}, {key2} are defined
    const headerRow = worksheet.getRow(18);

    const headers = headerRow.values.slice(1); // Removing the first element since it's a row number (ExcelJS behavior)

    // Iterate over the valuesArray to insert data into the template
    valuesArray.forEach((values, index) => {
        // Create a new row starting from the 19th row (index 19 in Excel)
        const newRow = worksheet.addRow([]);

        // Iterate through the headers and match with the keys from the values object
        headers.forEach((header, colIndex) => {
            // Check if the header matches a key in the values object
            const key = header.replace(/[{}]/g, ''); // Remove curly braces from the key name

            // Search for the corresponding key in the values object
            const value = values[key];

            if (value !== undefined) {
                // If the key exists, insert the value into the row cell
                newRow.getCell(colIndex + 1).value = value;
            } else {
                // If no value found, leave the cell blank
                newRow.getCell(colIndex + 1).value = null;
            }
        });
    });

    worksheet.spliceRows(18, 1); // This will remove the 18th row

    // Save the updated Excel file after filling in the data
    const updatedFilePath = path.join(outputFolder, 'filled-patrak.xlsx');
    await workbook.xlsx.writeFile(updatedFilePath);
    console.log(`Template filled and saved as "${updatedFilePath}".`);
}

async function getSchoolDetail() {
    const groupid = process.env.GROUP_ID;
    const school_id = process.env.SCHOOL_ID;
    const API_URL = process.env.API_URL;
    const group = groupid?.split(",");
    const url = API_URL;

    const data = {
        "_school": school_id,
    };

    try {
        // Make the POST request
        const response = await axios.post(url, data);

        // Assuming the response contains school details in the data
        return response.data.data;
    } catch (error) {
        console.error('Error making POST request:', error);
        return [];
    }
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
        return [];
    }
}

// Main function to execute the file moving and template filling
async function main() {
    try {
        // Check if template already exists
        if (!fs.existsSync(localTemplatePath)) {
            await downloadTemplate(templateUrl, localTemplatePath);
        }

        // Get data from API
        const schoolDetails = await getSchoolDetail();
        const marks = await getMarks();

        // Combine the data as needed
        const valuesArray = [...schoolDetails, ...marks];

        console.log('Filling the template...');
        await fillTemplate(valuesArray);

        console.log('Process completed successfully.');
    } catch (error) {
        console.error('Error during process:', error);
    }
}

main();
