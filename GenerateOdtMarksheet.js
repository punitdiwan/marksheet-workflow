// generateOdtFile_carbone.js
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const fetch = require('node-fetch');
const FormData = require('form-data');
const carbone = require('carbone');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const execPromise = util.promisify(exec);
const carboneRender = util.promisify(carbone.render);

// Initialize Supabase Client (use service role key for backend operations)
// const supabaseUrl = process.env.SUPABASE_URL;
// const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabaseUrl = "https://studio.maitretech.com";
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJzZXJ2aWNlX3JvbGUiLAogICAgImlzcyI6ICJzdXBhYmFzZS1kZW1vIiwKICAgICJpYXQiOiAxNjQxNzY5MjAwLAogICAgImV4cCI6IDE3OTk1MzU2MDAKfQ.DaYlNEoUrrEn2Ig7tqibS-PHK5vgusbcbo7X36XVt4Q";
if (!supabaseUrl || !supabaseKey) {
    throw new Error("Supabase URL and Service Key must be defined in environment variables.");
}
const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * Fetches the dynamic configuration (subjects, exams) for a marksheet.
 * @param {string[]} groupIds - Array of exam group UUIDs.
 * @param {string} courseId - The course UUID.
 * @returns {Promise<object>} - A configuration object.
 */
async function fetchMarksheetConfig(groupIds, courseId) {
    console.log(`Fetching config for groups: ${groupIds} and course: ${courseId}`);

    // 1. Fetch exam groups to get their codes (e.g., 't1', 't2')
    const { data: examGroups, error: groupsError } = await supabase
        .from('exam_groups')
        .select('group_code, name')
        .in('_uid', groupIds);
    if (groupsError) throw new Error(`Error fetching exam groups: ${groupsError.message}`);

    // 2. Fetch all exams within those groups
    const { data: exams, error: examsError } = await supabase
        .from('cce_exams')
        .select('exam_code, name, examgroups, subjects')
        .in('examgroups', groupIds);
    if (examsError) throw new Error(`Error fetching exams: ${examsError.message}`);

    // 3. Fetch all subjects for the given course
    // Assuming a linking table 'course_subjects' exists or subjects have a 'courses' foreign key
    const { data: subjects, error: subjectsError } = await supabase
        .from('subjects')
        .select('_uid, subject_name, subject_code')
        .eq('courses', courseId); // Adjust this query based on your schema
    if (subjectsError) throw new Error(`Error fetching subjects: ${subjectsError.message}`);

    console.log(`Found ${subjects.length} subjects and ${exams.length} exams for the configuration.`);
    return { examGroups, exams, subjects };
}

/**
 * Transforms flat student data into a structured format for Carbone.
 * This is the "magic" function that replaces the static mapping.
 * @param {object} studentData - The flat data for one student from your API.
 * @param {object} config - The configuration fetched by fetchMarksheetConfig.
 * @returns {object} - Structured data ready for Carbone.
 */
function transformStudentDataForCarbone(studentData, config) {
    const structured = {
        ...studentData, // Pass all original top-level data like full_name, dob, etc.
        subjects: [],
    };

    // Initialize grand totals
    const grandTotals = {};

    for (const subject of config.subjects) {
        const subjectRow = {
            name: subject.subject_name,
            // You can add more subject-specific fields here if needed
        };

        // Iterate through each exam group (e.g., Term 1, Term 2)
        for (const group of config.examGroups) {
            const groupCode = group.group_code; // e.g., 't1'

            // Find all exams belonging to this group
            const examsInGroup = config.exams.filter(ex => ex.examgroups === group._uid);

            for (const exam of examsInGroup) {
                const examCode = exam.exam_code; // e.g., 'pt', 'hy'
                const subjectCode = subject.subject_code; // e.g., 'engc'

                // Dynamically construct the key to find in the flat student data
                const dataKey = `${groupCode}_${subjectCode}_${examCode}`; // e.g., 't1_engc_pt'

                // Add the mark to our structured subject row
                const mark = studentData[dataKey] || '-';
                subjectRow[`${groupCode}_${examCode}`] = mark;

                // Add to grand totals
                const totalKey = `${groupCode}_${examCode}_total`;
                grandTotals[totalKey] = (grandTotals[totalKey] || 0) + (parseFloat(mark) || 0);
            }

            // Also get the subject's total marks and grade for this group
            const totalMarksKey = `${groupCode}_${subject.subject_code}_Ob_MarksC`;
            const gradeKey = `${groupCode}_${subject.subject_code}_GdC`;
            subjectRow[`${groupCode}_total`] = studentData[totalMarksKey] || '-';
            subjectRow[`${groupCode}_grade`] = studentData[gradeKey] || '-';
        }
        structured.subjects.push(subjectRow);
    }

    // Add the calculated grand totals to the top-level of the structured data
    Object.assign(structured, grandTotals);

    return structured;
}


async function GenerateOdtFile() {
    let outputDir = '';
    try {
        console.log("Starting dynamic marksheet generation with Carbone...");

        // Step 1: Get Payload from environment variables
        const groupid = process.env.GROUP_ID;
        const _school = process.env.SCHOOL_ID;
        const batchId = process.env.BATCH_ID;
        const jobId = process.env.JOB_ID;
        const courseId = process.env.COURSE_ID;
        const RANKING_ID = process.env.RANKING_ID;
        const DIVISION_ID = process.env.DIVISION_ID;
        const templateUrl = process.env.TEMPLATE_URL;
        const groupIds = groupid?.split(",");

        if (!templateUrl || !_school || !batchId || !jobId || !courseId || !groupIds) {
            throw new Error('Missing required environment variables.');
        }

        // Step 2: Fetch the dynamic configuration ONCE for this job
        const marksheetConfig = await fetchMarksheetConfig(groupIds, courseId);
        if (!marksheetConfig.subjects || marksheetConfig.subjects.length === 0) {
            console.warn("Warning: No subjects found for this course. Marksheets may be empty.");
        }

        // Step 3: Prepare directories
        outputDir = path.join('/tmp', `output_${Date.now()}`);
        await fs.promises.mkdir(outputDir, { recursive: true });
        const pdfPaths = [];

        // Step 4: Fetch student data
        const marksPayload = {
            _school: _school,
            batchId: [batchId],
            group: groupIds,
            "currentdata": {
                "division_id": DIVISION_ID,
                "ranking_id": RANKING_ID
            }
        };

        const studentResponse = await fetch('https://demoschool.edusparsh.com/api/cce_examv1/getMarks', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(marksPayload),
        });
        if (!studentResponse.ok) throw new Error(`Failed to fetch student data: ${studentResponse.statusText}`);

        const studentResponseJson = await studentResponse.json();
        const students = studentResponseJson.students || studentResponseJson.data || [];
        if (!Array.isArray(students) || students.length === 0) {
            console.warn("Warning: No students found. Exiting gracefully.");
            return;
        }
        console.log(`Generating marksheets for ${students.length} students...`);

        // Step 5: Download the template file once
        console.log("Downloading template from:", templateUrl);
        const templateBuffer = await downloadFile(templateUrl);
        const templatePath = path.join(outputDir, 'template.odt');
        await fs.promises.writeFile(templatePath, templateBuffer);

        // Step 6: Loop, Transform, and Render with Carbone
        for (const student of students) {
            console.log(`Processing student: ${student.full_name}`);
            const transformedData = transformStudentDataForCarbone(student, marksheetConfig);

            const fileSafeName = student.full_name?.replace(/\s+/g, '_') || `student_${Date.now()}`;
            const odtFilename = path.join(outputDir, `${fileSafeName}_filled.odt`);

            // Use Carbone to render the ODT
            const report = await carboneRender(templatePath, transformedData, {});
            await fs.promises.writeFile(odtFilename, report);

            const pdfPath = await convertOdtToPdf(odtFilename, outputDir);
            pdfPaths.push(pdfPath);
        }

        // Step 7: Merge, Upload, and Update Job (This part remains the same as your original script)
        if (pdfPaths.length > 0) {
            const mergedPdfPath = path.join(outputDir, 'merged_output.pdf');
            await mergePdfs(pdfPaths, mergedPdfPath);

            const filePath = `templates/marksheets/${_school}/result/${batchId}_${jobId}.pdf`;
            const fileBuffer = await fs.promises.readFile(mergedPdfPath);
            // ... (rest of your upload and job update logic)
            console.log("File upload and job history update logic would run here...");
        } else {
            console.log('No PDFs were generated to merge.');
        }

        console.log("Marksheets generated successfully.");

    } catch (error) {
        console.error('FATAL ERROR during marksheet generation:', error);
        process.exit(1);
    } finally {
        if (outputDir && fs.existsSync(outputDir)) {
            await fs.promises.rm(outputDir, { recursive: true, force: true });
        }
    }
}

// --- UTILITY FUNCTIONS (mostly from your original script) ---

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