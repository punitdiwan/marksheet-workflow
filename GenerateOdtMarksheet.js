// GenerateOdtMarksheet.js

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const fetch = require('node-fetch');
const carbone = require('carbone');
const { createClient } = require('@supabase/supabase-js');
const { PDFDocument } = require('pdf-lib');
require('dotenv').config();

const execPromise = util.promisify(exec);
const carboneRender = util.promisify(carbone.render);

// --- START: HARDCODE YOUR SECRETS HERE FOR TESTING ---
// ⚠️ Replace with your actual Supabase URL and Service Key
// const supabaseUrl = process.env.SUPABASE_URL;
// const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabaseUrl = "https://studio.maitretech.com";
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJzZXJ2aWNlX3JvbGUiLAogICAgImlzcyI6ICJzdXBhYmFzZS1kZW1vIiwKICAgICJpYXQiOiAxNjQxNzY5MjAwLAogICAgImV4cCI6IDE3OTk1MzU2MDAKfQ.DaYlNEoUrrEn2Ig7tqibS-PHK5vgusbcbo7X36XVt4Q";
// --- END: HARDCODE YOUR SECRETS HERE ---



// Get the dynamic schema name from the environment variables provided by the workflow
const schemaName = process.env.SCHOOL_ID;

// CRITICAL: Check if the schema name is provided.
if (!schemaName) {
    throw new Error("FATAL: SCHOOL_ID (which is used as the schema name) is not defined in environment variables.");
}

console.log(`✅ Initializing Supabase client for schema: "${schemaName}"`);

// Initialize Supabase Client with the dynamic schema
const supabase = createClient(supabaseUrl, supabaseKey, {
    db: {
        schema: schemaName,
    },
});

// ⬆️ --- END OF THE KEY CHANGE --- ⬆️


async function fetchMarksheetConfig(groupIds, courseId) {
    // This function will now correctly query within the specified schema
    console.log(`Fetching config for groups: ${groupIds} and course: ${courseId}`);

    const { data: examGroups, error: groupsError } = await supabase
        .from('exam_groups') // No need to change this line. The client handles the schema.
        .select('_uid, group_code, name')
        .in('_uid', groupIds);
    if (groupsError) throw new Error(`Error fetching exam groups: ${groupsError.message}`);

    // ... rest of the function is the same ...
    const { data: exams, error: examsError } = await supabase
        .from('cce_exams')
        .select('exam_code, name, examgroups, subjects!inner(_uid, subject_name, subject_code)')
        .in('examgroups', groupIds);
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

// ... the rest of your file (transformStudentDataForCarbone, GenerateOdtFile, utilities) remains exactly the same.
// Just ensure the new client initialization block is at the top.

function transformStudentDataForCarbone(studentData, config) {
    const structured = { ...studentData, subjects: [] };
    const grandTotals = {};

    for (const subject of config.subjects) {
        const subjectRow = { name: subject.subject_name };

        for (const group of config.examGroups) {
            const groupCode = group.group_code;
            const examsInGroup = config.exams.filter(ex => ex.examgroups === group._uid && ex.subjects._uid === subject._uid);

            for (const exam of examsInGroup) {
                const dataKey = `${groupCode}_${subject.subject_code}_${exam.exam_code}`;
                const mark = studentData[dataKey] || '-';
                subjectRow[`${groupCode}_${exam.exam_code}`] = mark;
                const totalKey = `${groupCode}_${exam.exam_code}_total`;
                grandTotals[totalKey] = (grandTotals[totalKey] || 0) + (parseFloat(mark) || 0);
            }
            const totalMarksKey = `${groupCode}_${subject.subject_code}_Ob_MarksC`;
            const gradeKey = `${groupCode}_${subject.subject_code}_GdC`;
            subjectRow[`${groupCode}_total`] = studentData[totalMarksKey] || '-';
            subjectRow[`${groupCode}_grade`] = studentData[gradeKey] || '-';
        }
        structured.subjects.push(subjectRow);
    }

    Object.assign(structured, grandTotals);
    return structured;
}


async function GenerateOdtFile() {
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

        const marksheetConfig = await fetchMarksheetConfig(groupIds, courseId);
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
            await supabase.from('job_history').update({ status: true, notes: "Completed: No students found." }).eq('_uid', jobId);
            return;
        }
        console.log(`Generating marksheets for ${students.length} students...`);

        const templateBuffer = await downloadFile(templateUrl);

        for (const student of students) {
            console.log(`Processing student: ${student.full_name}`);
            const transformedData = transformStudentDataForCarbone(student, marksheetConfig);
            const odtReport = await carboneRender(templateBuffer, transformedData);

            const fileSafeName = student.full_name?.replace(/\s+/g, '_') || `student_${Date.now()}`;
            const odtFilename = path.join(outputDir, `${fileSafeName}.odt`);
            await fs.promises.writeFile(odtFilename, odtReport);

            const pdfPath = await convertOdtToPdf(odtFilename, outputDir);
            pdfPaths.push(pdfPath);
        }

        if (pdfPaths.length > 0) {
            const mergedPdfPath = path.join(outputDir, 'merged_output.pdf');
            await mergePdfs(pdfPaths, mergedPdfPath);

            const filePath = `templates/marksheets/${schoolId}/result/${batchId}_${jobId}.pdf`;
            const fileBuffer = await fs.promises.readFile(mergedPdfPath);

            console.log(`Uploading merged PDF to Supabase Storage at: ${filePath}`);
            const { error: uploadError } = await supabase.storage
                .from('schoolerp-bucket') // CHANGE to your bucket name
                .upload(filePath, fileBuffer, { contentType: 'application/pdf', upsert: true });
            if (uploadError) throw new Error(`Supabase upload failed: ${uploadError.message}`);

            console.log("Updating job_history table...");
            const { error: updateError } = await supabase
                .from('job_history')
                .update({ file_path: filePath, status: true })
                .eq('_uid', jobId);
            if (updateError) throw new Error(`Failed to update job_history: ${updateError.message}`);
        } else {
            console.log('No PDFs were generated to merge.');
        }
        console.log("Marksheets generated successfully.");

    } catch (error) {
        console.error('FATAL ERROR during marksheet generation:', error);
        if (jobId) {
            await supabase.from('job_history').update({ status: false, notes: `Failed: ${error.message}`.substring(0, 500) }).eq('_uid', jobId);
        }
        process.exit(1);
    }
}

// --- UTILITY FUNCTIONS ---
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