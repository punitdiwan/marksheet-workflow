const axios = require('axios');
require('dotenv').config({ path: '../.env' });
const JOB_URL = process.env.JOB_URL;
const school = process.env.SCHOOL_ID;
const batchId = process.env.BATCH_ID;
const uid = process.env.JOB_ID;


(async () => {

    const now = Date.now();
    let filename = `${batchId}_${uid}.xlsx`
    console.log("now", now);


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