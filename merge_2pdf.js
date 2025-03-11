const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
require('dotenv').config({ path: '../.env' });
const JOB_URL = process.env.JOB_URL;
const school = process.env.SCHOOL_ID;
const batchId = process.env.BATCH_ID;
const uid = process.env.JOB_ID;
const generate_pdf = process.env.GENERATE_PDF;

(async () => {

    const now = Date.now();
    let filename = `${batchId}_${uid}.pdf`
    console.log("now", now);
    if (generate_pdf == 'true') {
        filename = `${batchId}_${uid}.pdf`
    } else {
        filename = `${batchId}_${uid}.zip`
    }
    if (generate_pdf == 'true') {
        const { default: PDFMerger } = await import('pdf-merger-js');  // Correct way to import in ESM
        const merger = new PDFMerger();  // Now we can create an instance

        const docxDirectory = path.resolve(__dirname);
        const files = fs.readdirSync(docxDirectory);  // Now fs is available
        const pdfFiles = files.filter(file => file.endsWith('.pdf'));

        // Add the filtered PDF files to the merger
        for (const file of pdfFiles) {
            await merger.add(path.join(docxDirectory, file));  // Use the full path for each file
        }

        // Set metadata
        await merger.setMetadata({
            producer: "pdf-merger-js based script",
            author: "John Doe",
            creator: "John Doe",
            title: "Student Marksheet"
        });

        // Save the merged PDF
        const mergedPdfPath = 'merged.pdf';
        await merger.save(mergedPdfPath);
    }
    const key = `templates/marksheets/${school}/result/${filename}`;

    const jobHistoryData = {
        _school: school,
        table: "job_history",
        _uid: uid,
        payload: {
            status: true,
            file_path: key  // Assuming file_path is returned from the first API call
        }
    };
    const updateResponse = await axios.post(JOB_URL, jobHistoryData, {
        headers: {
            'Content-Type': 'application/json',  // Make sure the content type is application/json for API update
        }
    });
    console.log('Job history updated:', updateResponse.data);
})();