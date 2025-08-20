// =================================================================
//          GenerateOdtMarksheet.js (The Final Correct Version)
// =================================================================

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const fetch = require('node-fetch');
const carbone = require('carbone');
const { createClient } = require('@supabase/supabase-js');
const FormData = require('form-data');
require('dotenv').config();

const execPromise = util.promisify(exec);
const carboneRender = util.promisify(carbone.render);

// --- START: HARDCODE YOUR SECRETS HERE FOR TESTING ---
// ⚠️ CRITICAL: I have corrected your Supabase URL. Please verify it is correct.
// It MUST be the API URL from your Supabase dashboard, NOT the studio login URL.
const supabaseUrl = "https://jdbzjbxv.supabase.co"; // Correct API URL format
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJzZXJ2aWNlX3JvbGUiLAogICAgImlzcyI6ICJzdXBhYmFzZS1kZW1vIiwKICAgICJpYXQiOiAxNjQxNzY5MjAwLAogICAgImV4cCI6IDE3OTk1MzU2MDAKfQ.DaYlNEoUrrEn2Ig7tqibS-PHK5vgusbcbo7X36XVt4Q";
// --- END: HARDCODE YOUR SECRETS HERE ---

const schemaName = process.env.SCHOOL_ID;

if (!schemaName) {
    throw new Error("FATAL: SCHOOL_ID (which is used as the schema name) is not defined in environment variables.");
}

console.log(`✅ Initializing Supabase client for schema: "${schemaName}"`);

const supabase = createClient(supabaseUrl, supabaseKey, {
    db: {
        schema: schemaName,
    },
});

async function fetchMarksheetConfig(groupIds) {
    // This function is correct. No changes needed.
    console.log(`Fetching config for groups: ${groupIds}`);
    const { data: examGroups, error: groupsError } = await supabase.from('exam_groups').select('_uid, group_code, name').in('_uid', groupIds);
    if (groupsError) throw new Error(`Error fetching exam groups: ${groupsError.message}`);
    const { data: exams, error: examsError } = await supabase.from('cce_exams').select('exam_code, name, examgroups, subjects!inner(_uid, sub_name, code)').in('examgroups', groupIds);
    if (examsError) throw new Error(`Error fetching exams: ${examsError.message}`);
    const subjectsMap = new Map();
    exams.forEach(exam => {
        if (exam.subjects && !subjectsMap.has(exam.subjects._uid)) {
            subjectsMap.set(exam.subjects._uid, exam.subjects);
        }
    });
    const subjects = Array.from(subjectsMap.values());
    console.log(`Found ${subjects.length} unique subjects and ${exams.length} exams.`);
    return { examGroups, exams, subjects };
}

function transformStudentDataForCarbone(studentData, config) {
    const structured = { ...studentData, subjects: [] };
    const grandTotals = {};

    for (const subject of config.subjects) {
        const subjectRow = { name: subject.sub_name };

        for (const group of config.examGroups) {
            const groupCode = group.group_code;
            const examsInGroup = config.exams.filter(ex => ex.examgroups === group._uid && ex.subjects._uid === subject._uid);

            for (const exam of examsInGroup) {
                // Step 1: Find the specific mark in the raw data (e.g., 'hy_1_pt')
                const dataKey = `${groupCode}_${subject.code}_${exam.exam_code}`;
                const mark = studentData[dataKey] || '-';

                // ⬇️ --- THIS IS THE FIX --- ⬇️
                // Step 2: Create a GENERIC key in the subjectRow (e.g., 'hy_pt'), which matches your template
                subjectRow[`${groupCode}_${exam.exam_code}`] = mark;

                // Grand total logic is correct
                const totalKey = `${groupCode}_${exam.exam_code}_total`;
                grandTotals[totalKey] = (grandTotals[totalKey] || 0) + (parseFloat(mark) || 0);
            }
            const totalMarksKey = `${groupCode}_${subject.code}_Ob_MarksC`;
            const gradeKey = `${groupCode}_${subject.code}_GdC`;
            subjectRow[`${groupCode}_total`] = studentData[totalMarksKey] || '-';
            subjectRow[`${groupCode}_grade`] = studentData[gradeKey] || '-';
        }
        structured.subjects.push(subjectRow);
    }

    Object.assign(structured, grandTotals);

    // Logging to verify the fix
    console.log(`\n--- VERIFY THIS JSON LOG ---`);
    console.log(`Data for student: ${studentData.full_name || 'N/A'}`);
    console.log(JSON.stringify(structured.subjects, null, 2)); // Log only the subjects array for clarity
    console.log(`--------------------------\n`);

    return structured;
}

async function GenerateOdtFile() {
    // This entire function is correct. No changes needed.
    let outputDir = '';
    const jobId = process.env.JOB_ID;
    try {
        console.log("Starting dynamic marksheet generation with Carbone...");
        const groupid = process.env.GROUP_ID;
        const schoolId = process.env.SCHOOL_ID;
        const batchId = process.env.BATCH_ID;
        const courseId = process.env.COURSE_ID;
        const RANKING_ID = process.env.RANKING_ID;
        const DIVISION_ID = process.env.DIVISION_ID;
        const templateUrl = process.env.TEMPLATE_URL;
        const groupIds = groupid?.split(",");

        if (!templateUrl || !schoolId || !batchId || !jobId || !courseId || !groupIds) {
            throw new Error('Missing required environment variables from GitHub Actions inputs.');
        }
        const marksheetConfig = await fetchMarksheetConfig(groupIds);
        if (!marksheetConfig.subjects || marksheetConfig.subjects.length === 0) {
            console.warn("Warning: No subjects found for this course. Marksheets may be empty.");
        }
        outputDir = path.join(process.cwd(), 'output');
        await fs.promises.mkdir(outputDir, { recursive: true });
        const pdfPaths = [];
        const marksPayload = {
            _school: schoolId,
            batchId: [batchId],
            group: groupIds,
            "currentdata": { "division_id": DIVISION_ID, "ranking_id": RANKING_ID }
        };
        const studentResponse = await fetch('https://demoschool.edusparsh.com/api/cce_examv1/getMarks', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(marksPayload),
        });
        if (!studentResponse.ok) throw new Error(`Failed to fetch student data: ${await studentResponse.text()}`);
        const studentResponseJson = await studentResponse.json();
        const students = studentResponseJson.students || studentResponseJson.data || [];
        if (!Array.isArray(students) || students.length === 0) {
            console.warn("Warning: No students found. Exiting gracefully.");
            await updateJobHistory(jobId, schoolId, { status: true, notes: "Completed: No students found." });
            return;
        }
        console.log(`Generating marksheets for ${students.length} students...`);
        console.log("Downloading template from URL...");
        const templateBuffer = await downloadFile(templateUrl);
        const templatePath = path.join(outputDir, 'template.odt');
        await fs.promises.writeFile(templatePath, templateBuffer);
        console.log(`Template saved locally to: ${templatePath}`);
        for (const student of students) {
            console.log(`Processing student: ${student.full_name}`);
            const transformedData = transformStudentDataForCarbone(student, marksheetConfig);
            const odtReport = await carboneRender(templatePath, transformedData);
            const fileSafeName = student.full_name?.replace(/\s+/g, '_') || `student_${Date.now()}`;
            const odtFilename = path.join(outputDir, `${fileSafeName}.odt`);
            await fs.promises.writeFile(odtFilename, odtReport);
            const pdfPath = await convertOdtToPdf(odtFilename, outputDir);
            pdfPaths.push(pdfPath);
        }
        const mergedPdfPath = path.join(outputDir, 'merged_output.pdf');
        if (pdfPaths.length > 0) {
            await mergePdfs(pdfPaths, mergedPdfPath);
            const filePath = `templates/marksheets/${schoolId}/result/${batchId}_${jobId}.pdf`;
            const fileBuffer = await fs.promises.readFile(mergedPdfPath);
            const formData = new FormData();
            formData.append('photo', fileBuffer, {
                filename: 'merged_output.pdf',
                contentType: 'application/pdf',
            });
            formData.append('key', filePath);
            formData.append('ContentType', 'application/pdf');
            formData.append('jobId', jobId);
            console.log(`Uploading merged PDF via API to path: ${filePath}`);
            const uploadRes = await fetch('https://demoschool.edusparsh.com/api/uploadfileToDigitalOcean', {
                method: 'POST',
                headers: formData.getHeaders(),
                body: formData,
            });
            if (!uploadRes.ok) {
                const errorData = await uploadRes.text();
                throw new Error(`File upload API failed: ${errorData || uploadRes.statusText}`);
            }
            console.log("File uploaded successfully. Updating job_history table via API...");
            await updateJobHistory(jobId, schoolId, { file_path: filePath, status: true });
            console.log('Job_history updated successfully.');
        } else {
            console.log('No PDFs were generated to merge.');
        }
        console.log("✅ Marksheets generated and uploaded successfully.");
    } catch (error) {
        console.error('❌ FATAL ERROR during marksheet generation:', error);
        if (jobId) {
            await updateJobHistory(jobId, schemaName, { status: false, notes: `Failed: ${error.message}`.substring(0, 500) });
        }
        process.exit(1);
    }
}

// --- UTILITY FUNCTIONS ---

async function updateJobHistory(jobId, schoolId, payload) {
    try {
        const jobUpdatePayload = {
            _school: schoolId,
            table: 'job_history',
            _uid: jobId,
            payload: payload,
        };
        const jobUpdateRes = await fetch("https://demoschool.edusparsh.com/api/updatejobHistory", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(jobUpdatePayload),
        });
        if (!jobUpdateRes.ok) {
            const errorData = await jobUpdateRes.text();
            console.error(`Could not update job_history via API: ${errorData || jobUpdateRes.statusText}`);
        }
    } catch (apiError) {
        console.error("An error occurred while trying to call the updateJobHistory API.", apiError);
    }
}

async function downloadFile(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to download file: ${res.statusText}`);
    return Buffer.from(await res.arrayBuffer());
}

async function convertOdtToPdf(odtPath, outputDir) {
    const command = `libreoffice --headless --convert-to pdf --outdir "${outputDir}" "${odtPath}"`;
    await execPromise(command);
    return path.join(outputDir, path.basename(odtPath, '.odt') + '.pdf');
}

async function mergePdfs(pdfPaths, outputPath) {
    if (pdfPaths.length === 0) return;
    const command = `pdftk ${pdfPaths.map(p => `"${p}"`).join(' ')} cat output "${outputPath}"`;
    await execPromise(command);
}

// --- EXECUTION ---
GenerateOdtFile();