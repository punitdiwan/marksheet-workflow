const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

// Directory where .docx files are located
const docxDirectory = path.resolve(__dirname);
const files = fs.readdirSync(docxDirectory);

// Filter out the .docx files
const docxFiles = files.filter(file => file.endsWith('.docx'));

// Sort files based on the numerical prefix (before the first underscore '_')
const sortedFiles = docxFiles.sort((a, b) => {
    // Extract the numerical prefix before the first underscore '_'
    const prefixA = parseInt(a.split('_')[0], 10); // e.g., '23' from '23_YASH VISHWAKARMA.docx'
    const prefixB = parseInt(b.split('_')[0], 10); // e.g., '24' from '24_JOHN DOE.docx'

    return prefixA - prefixB; // Sort numerically in ascending order
});

// Function to upload files in batches
async function uploadFilesInBatches(files, batchSize) {
    for (let i = 0; i < files.length; i += batchSize) {
        // Create a batch of files
        const batch = files.slice(i, i + batchSize);
        const formData = new FormData();

        // Add each file in the batch to the formData
        batch.forEach(file => {
            formData.append('files', fs.createReadStream(path.join(docxDirectory, file)));
        });

        formData.append('merge', 'true');

        // Define the API endpoint
        const url = 'https://demo.gotenberg.dev/forms/libreoffice/convert';

        try {
            const response = await axios.post(url, formData, {
                headers: formData.getHeaders(),
                responseType: 'stream',
            });

            // Save the response as a PDF file
            const writer = fs.createWriteStream(`output_batch_${i / batchSize + 1}.pdf`);
            response.data.pipe(writer);

            writer.on('finish', () => {
                console.log(`PDF saved as output_batch_${i / batchSize + 1}.pdf`);
            });

            writer.on('error', (err) => {
                console.error('Error saving PDF:', err);
            });
        } catch (error) {
            console.error('Error during batch upload:', error.message);
        }
    }
}

// Call the function with a batch size of 5 (or whatever size you prefer)
uploadFilesInBatches(sortedFiles, 5);
