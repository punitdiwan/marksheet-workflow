const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const axios = require('axios');

// URL of the template file
const outputDir = path.resolve(__dirname, 'output');
const localTemplatePath = path.resolve(__dirname, 'local_template.docx');
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

// Function to merge data with the downloaded template
const mergeDocxTemplate = (templatePath, outputPath, data) => {
    try {
        const templateContent = fs.readFileSync(templatePath, 'binary');
        const zip = new PizZip(templateContent);
        const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
        doc.render(data);
        const buffer = doc.getZip().generate({ type: 'nodebuffer' });
        fs.writeFileSync(outputPath, buffer);
        console.log(`Document saved: ${outputPath}`);
    } catch (error) {
        console.error('Error creating document:', error);
    }
};

// Function to update document metadata (creator)
const setCreatorInDocx = (inputFile, outputFile, creatorName) => {
    try {
        const fileBuffer = fs.readFileSync(inputFile);
        const zip = new PizZip(fileBuffer);
        const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
        const docProps = doc.getZip().files['docProps/core.xml'];
        const xmlContent = docProps._data.toString();
        const updatedXml = xmlContent.replace(/<dc:creator>(.*?)<\/dc:creator>/, `<dc:creator>${creatorName}</dc:creator>`);
        doc.getZip().files['docProps/core.xml']._data = Buffer.from(updatedXml, 'utf-8');
        const outputBuffer = doc.getZip().generate({ type: 'nodebuffer' });
        fs.writeFileSync(outputFile, outputBuffer);
        console.log(`Creator set successfully to "${creatorName}" in ${outputFile}`);
    } catch (error) {
        console.error('Error setting creator:', error);
    }
};

async function getMarks() {
    const groupid = process.env.GROUP_ID;
    const batchId = process.env.BATCH_ID;
    const _school = process.env.SCHOOL_ID;
    const RANKING_ID = process.env.RANKING_ID;
    const DIVISION_ID = process.env.DIVISION_ID;
    const API_URL = process.env.API_URL;
    const group = groupid?.split(",")
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

// Main function to generate documents and perform operations
const generateDocuments = async () => {
    try {
        // Download the template
        await downloadTemplate(templateUrl, localTemplatePath);

        const data = await getMarks();

        data.forEach((record, index) => {
            const studentname = record?.full_name || 'NA';
            const outputPath = path.resolve(outputDir, `${index + 1}_${studentname}.docx`);
            mergeDocxTemplate(localTemplatePath, outputPath, record);
            setCreatorInDocx(outputPath, outputPath, "John Joe"); // Set creator metadata for each document
        });

    } catch (error) {
        console.error('Error generating documents:', error);
    }
};

generateDocuments();
