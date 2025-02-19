// const fs = require('fs'); // Add this import to use fs module
// const path = require('path');

// (async () => {
//     const { default: PDFMerger } = await import('pdf-merger-js');  // Correct way to import in ESM
//     const merger = new PDFMerger();  // Now we can create an instance

//     const docxDirectory = path.resolve(__dirname);
//     const files = fs.readdirSync(docxDirectory);  // Now fs is available
//     const pdfFiles = files.filter(file => file.endsWith('.pdf'));

//     // Add the filtered PDF files to the merger
//     for (const file of pdfFiles) {
//         await merger.add(path.join(docxDirectory, file));  // Use the full path for each file
//     }

//     // Set metadata
//     await merger.setMetadata({
//         producer: "pdf-merger-js based script",
//         author: "John Doe",
//         creator: "John Doe",
//         title: "My life as John Doe"
//     });

//     // Save the merged PDF
//     await merger.save('merged.pdf');
// })();


const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
require('dotenv').config({ path: '../.env' });
const JOB_URL = process.env.JOB_URL;
const school = process.env.SCHOOL_ID;
const batchId = process.env.BATCH_ID;
const uid = process.env.JOB_ID;

(async () => {

    const now = Date.now();
    const filename = `${batchId}_${uid}.pdf`
    console.log("now", now);


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
    const key = `templates/marksheets/${school}/result/${filename}`;

    // Now upload the merged PDF to DigitalOcean or your server
    // const fileToUpload = fs.createReadStream(mergedPdfPath);  // Create a readable stream for the file
    // const formData = new FormData();
    // formData.append("photo", fileToUpload);
    // formData.append("key", key);  // Using the saved file name as the key
    // formData.append("ContentType", 'application/pdf');  // Set the appropriate content type

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


    // // Make the POST request to upload the file using axios
    // const res = await axios.post(`${API_URL}/api/uploadfileToDigitalOcean`, formData, {
    //     headers: {
    //         'Content-Type': 'multipart/form-data',  // Make sure to set the correct content type
    //     }
    // });

    // // Handle the response
    // if (res.status === 200) {
    //     console.log('File uploaded successfully!');

    // } else {
    //     console.error('Failed to upload file:', res.statusText);
    // }
})();

