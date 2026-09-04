const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const fetch = require('node-fetch');
const carbone = require('carbone');

// --- NEW: ADD CUSTOM FORMATTER ---
carbone.formatters.showWithLabel = function (value, label) {
    // If value is empty, return nothing (an empty string).
    if (value === null || value === undefined || value === '') {
        return '';
    }
    // If value exists, return the label followed by the value.
    return label + ' ' + value;
};
// --- END OF NEW FORMATTER ---

// --- NEW: CO-SCHOLASTIC GRADE FORMATTER ---
carbone.formatters.coGrade = function (coScholastic, subjectName, groupCode) {
    // 1. Debug Log: Check if function is called
    console.log(`DEBUG: coGrade called for Subject: "${subjectName}", Group: "${groupCode}"`);

    if (!Array.isArray(coScholastic)) {
        console.log("DEBUG: coScholastic is not an array or is empty.");
        return "";
    }

    const targetName = String(subjectName).trim().toLowerCase();

    const subject = coScholastic.find(s =>
        String(s.name || "")
            .trim()
            .toLowerCase() === targetName
    );

    if (!subject) {
        console.log(`DEBUG: Subject "${targetName}" not found in list.`);
        return "";
    }

    const result = subject.groups?.[groupCode]?.grade ?? "";
    console.log(`DEBUG: Found grade: "${result}"`);
    return result;
};
// --- END OF NEW FORMATTER ---



const FormData = require('form-data');
const yauzl = require('yauzl');
const yazl = require('yazl');
const sharp = require('sharp');
const xml2js = require('xml2js');
const { PDFDocument, rgb } = require('pdf-lib');
require('dotenv').config();

const execPromise = util.promisify(exec);
const carboneRender = util.promisify(carbone.render);
const parseXml = util.promisify(xml2js.parseString);

// --- NEW: Extract series (exam columns) from template table placed before image frame ---
async function extractSeriesFromTemplate(contentXmlPath, frameName) {
    try {
        const contentXml = await fs.readFile(contentXmlPath, 'utf-8');
        const parsed = await parseXml(contentXml, {
            explicitArray: false,
            ignoreAttrs: false,
            mergeAttrs: false,
            explicitChildren: true,
            preserveChildrenOrder: true
        });

        const textBody = parsed['office:document-content']?.['office:body']?.['office:text'];
        if (!textBody) return null;

        // Helper: normalize headers and prefer exam-like keys (pt, term, overall)
        function normalizeAndFilterHeaders(headers) {
            const mapped = headers.map(h => {
                const k = String(h).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
                if (k.includes('pt') && k.includes('1')) return 'pt1';
                if (k.includes('pt') && k.includes('2')) return 'pt2';
                if (k.includes('term') && k.includes('1')) return 't1';
                if (k.includes('term') && k.includes('2')) return 't2';
                if (k.includes('over') || k.includes('overall') || k.includes('grand')) return 'overall';
                return k;
            }).filter(Boolean);

            const examLike = mapped.filter(k => /pt1|pt2|t1|t2|term|overall|grand/.test(k));
            return examLike.length ? examLike : mapped;
        }

        // Build an ordered list of nodes (pre-order traversal) so we can find nearest tables/frames anywhere
        const ordered = [];
        function traverse(node) {
            if (!node || typeof node !== 'object') return;
            if (node['#name']) ordered.push(node);
            const children = node.$$ || [];
            for (const c of children) traverse(c);
        }
        traverse(textBody);

        // Find any table whose attributes contain the frameName (search globally first)
        const tables = ordered.filter(n => n['#name'] === 'table:table');
        for (const t of tables) {
            const attrs = t.$ || {};
            const attrValues = Object.values(attrs).map(v => String(v));
            if (attrValues.includes(String(frameName))) {
                console.log(`ℹ️ extractSeriesFromTemplate: found table with attribute matching '${frameName}'.`);
                const rows = (t.$$ || []).filter(tc => tc['#name'] === 'table:table-row');
                if (rows.length === 0) break;
                const headerRow = rows.find(r => (r.$$ || []).some(c => c['#name'] === 'table:table-cell')) || rows[0];
                const headers = [];
                for (const cell of headerRow.$$ || []) {
                    if (cell['#name'] !== 'table:table-cell') continue;
                    let cellText = '';
                    if (cell.$$) {
                        for (const cc of cell.$$) {
                            if (cc['#name'] === 'text:p' && typeof cc._ === 'string') cellText += cc._;
                            else if (cc['#name'] === 'text:p' && Array.isArray(cc._)) cellText += cc._.join(' ');
                            else if (cc['#name'] === 'text:p' && cc.$$) {
                                for (const span of cc.$$) if (typeof span._ === 'string') cellText += span._;
                            }
                        }
                    }
                    cellText = (cellText || '').trim();
                    if (cellText) headers.push(cellText);
                }
                console.log(`ℹ️ extractSeriesFromTemplate: raw headers for table named ${frameName}: ${JSON.stringify(headers)}`);
                const normalized = normalizeAndFilterHeaders(headers);
                console.log(`ℹ️ extractSeriesFromTemplate: normalized series keys: ${JSON.stringify(normalized)}`);
                return normalized.length ? normalized : null;
            }
        }

        // If none matched by name, scan all tables for exam-like headers and pick the first matching table
        for (const t of tables) {
            const rows = (t.$$ || []).filter(tc => tc['#name'] === 'table:table-row');
            if (rows.length === 0) continue;
            const headerRow = rows.find(r => (r.$$ || []).some(c => c['#name'] === 'table:table-cell')) || rows[0];
            const headers = [];
            for (const cell of headerRow.$$ || []) {
                if (cell['#name'] !== 'table:table-cell') continue;
                let cellText = '';
                if (cell.$$) {
                    for (const cc of cell.$$) {
                        if (cc['#name'] === 'text:p' && typeof cc._ === 'string') cellText += cc._;
                        else if (cc['#name'] === 'text:p' && Array.isArray(cc._)) cellText += cc._.join(' ');
                        else if (cc['#name'] === 'text:p' && cc.$$) {
                            for (const span of cc.$$) if (typeof span._ === 'string') cellText += span._;
                        }
                    }
                }
                cellText = (cellText || '').trim();
                if (cellText) headers.push(cellText);
            }
            const normalized = normalizeAndFilterHeaders(headers);
            // pick this table if it contains explicit exam-like keys
            if (normalized.some(k => /pt1|pt2|t1|t2|overall/.test(k))) {
                console.log(`ℹ️ extractSeriesFromTemplate: selected table by matching header keywords: ${JSON.stringify(normalized)}`);
                return normalized;
            }
        }

        // Find frame position and then nearest preceding table
        let framePos = -1;
        for (let i = 0; i < ordered.length; i++) {
            const n = ordered[i];
            if (n['#name'] === 'draw:frame') {
                const attrs = n.$ || {};
                if (attrs['draw:name'] === frameName) { framePos = i; break; }
            }
        }

        if (framePos === -1 && ordered.length > 0) console.log(`ℹ️ extractSeriesFromTemplate: frame '${frameName}' not found; falling back to first nearby table.`);

        for (let j = (framePos === -1 ? ordered.length - 1 : framePos - 1); j >= 0; j--) {
            const node = ordered[j];
            if (!node) continue;
            if (node['#name'] === 'table:table') {
                const rows = (node.$$ || []).filter(tc => tc['#name'] === 'table:table-row');
                if (rows.length === 0) continue;
                const headerRow = rows.find(r => (r.$$ || []).some(c => c['#name'] === 'table:table-cell')) || rows[0];
                const headers = [];
                for (const cell of headerRow.$$ || []) {
                    if (cell['#name'] !== 'table:table-cell') continue;
                    let cellText = '';
                    if (cell.$$) {
                        for (const cc of cell.$$) {
                            if (cc['#name'] === 'text:p' && typeof cc._ === 'string') cellText += cc._;
                            else if (cc['#name'] === 'text:p' && Array.isArray(cc._)) cellText += cc._.join(' ');
                            else if (cc['#name'] === 'text:p' && cc.$$) {
                                for (const span of cc.$$) if (typeof span._ === 'string') cellText += span._;
                            }
                        }
                    }
                    cellText = (cellText || '').trim();
                    if (cellText) headers.push(cellText);
                }
                console.log(`ℹ️ extractSeriesFromTemplate: raw headers near frame ${frameName}: ${JSON.stringify(headers)}`);
                const normalized = normalizeAndFilterHeaders(headers);
                console.log(`ℹ️ extractSeriesFromTemplate: normalized series keys (fallback): ${JSON.stringify(normalized)}`);
                return normalized.length ? normalized : null;
            }
        }
    } catch (err) {
        console.warn('⚠️ extractSeriesFromTemplate failed:', err.message);
    }
    return null;
}

// --- END NEW ---

// --- NEW: NAMING CONVENTION HELPER FUNCTION ---
/**
 * Applies a naming convention to all string values within a data structure.
 * @param {*} data The data to transform (object, array, or primitive).
 * @param {string} convention The convention to apply ('uppercase', 'lowercase', 'capitalize').
 * @returns {*} The transformed data.
 */
function applyNamingConvention(data, convention) {
    if (!convention || typeof data !== 'object' || data === null) {
        if (typeof data === 'string') {
            switch (convention.toLowerCase()) {
                case 'uppercase':
                    return data.toUpperCase();
                case 'lowercase':
                    return data.toLowerCase();
                case 'capitalize':
                    return data.replace(/\b\w/g, char => char.toUpperCase());
                default:
                    return data;
            }
        }
        return data;
    }

    if (Array.isArray(data)) {
        return data.map(item => applyNamingConvention(item, convention));
    }

    const newObj = {};
    for (const key in data) {
        if (Object.prototype.hasOwnProperty.call(data, key)) {
            newObj[key] = applyNamingConvention(data[key], convention);
        }
    }
    return newObj;
}
// --- END OF NEW HELPER FUNCTION ---

// --- UTILITY FUNCTIONS ---
async function updateJobHistory(jobId, schoolId, payload) {
    try {
        const jobUpdatePayload = {
            _school: schoolId,
            table: 'job_history',
            _uid: jobId,
            payload: payload
        };
        const jobUpdateRes = await fetch("https://demoschool.edusparsh.com/api/updatejobHistory", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(jobUpdatePayload),
        });
        if (!jobUpdateRes.ok) {
            const errorData = await jobUpdateRes.text();
            console.error(`⚠️ Could not update job_history: ${errorData || jobUpdateRes.statusText}`);
        }
    } catch (apiError) {
        console.error("⚠️ Error while updating job_history API.", apiError);
    }
}

async function downloadFile(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to download file: ${res.statusText}`);
    return Buffer.from(await res.arrayBuffer());
}

async function convertOdtToPdf(odtPath, outputDir) {
    const command = `libreoffice --headless --convert-to "pdf:writer_pdf_Export:EmbedStandardFonts=true" --outdir "${outputDir}" "${odtPath}"`;
    try {
        console.log(`🔄 Running conversion for: ${path.basename(odtPath)}`);
        const { stdout, stderr } = await execPromise(command);

        if (stderr) {
            console.warn(`[LibreOffice STDERR for ${path.basename(odtPath)}]:`, stderr);
        }

        return path.join(outputDir, path.basename(odtPath, '.odt') + '.pdf');
    } catch (error) {
        console.error(`❌ LibreOffice command failed for ${path.basename(odtPath)}.`);
        console.error('--- STDOUT ---');
        console.error(error.stdout);
        console.error('--- STDERR ---');
        console.error(error.stderr);
        throw new Error(`LibreOffice conversion failed. See logs above.`);
    }
}

async function normalizeTextSpans(xmlPath) {
    let xml = await fs.readFile(xmlPath, 'utf8');

    // Merge adjacent spans with same style
    xml = xml.replace(
        /<\/text:span>\s*<text:span[^>]*>/g,
        ''
    );

    await fs.writeFile(xmlPath, xml);
}

/**
 * Adds a white overlay to the top of a PDF file with configurable margins.
 * @param {string} inputPdfPath - The path to the input PDF.
 * @param {string} outputPdfPath - The path where the modified PDF will be saved.
 * @param {object} [options={}] - Configuration for the overlay.
 * @param {number} [options.heightCm=5] - The height of the overlay itself in centimeters.
 * @param {number} [options.topMarginCm=0] - The space from the absolute top of the page before the overlay begins, in centimeters.
 * @param {number} [options.leftMarginCm=0] - The margin from the left edge of the page in centimeters.
 * @param {number} [options.rightMarginCm=0] - The margin from the right edge of the page in centimeters.
 */
async function addWhiteOverlay(inputPdfPath, outputPdfPath, options = {}) {
    const {
        heightCm = 5,
        topMarginCm = 0,
        leftMarginCm = 0,
        rightMarginCm = 0,
    } = options;

    console.log(`🎨 Adding white overlay to ${path.basename(inputPdfPath)} with options:`, { heightCm, topMarginCm, leftMarginCm, rightMarginCm });

    try {
        const POINTS_PER_CM = 28.3465; // Standard conversion factor for PDF points (72 DPI)

        // Convert all dimensions from cm to points
        const overlayHeight = heightCm * POINTS_PER_CM;
        const topMargin = topMarginCm * POINTS_PER_CM;
        const leftMargin = leftMarginCm * POINTS_PER_CM;
        const rightMargin = rightMarginCm * POINTS_PER_CM;

        const existingPdfBytes = await fs.readFile(inputPdfPath);
        const pdfDoc = await PDFDocument.load(existingPdfBytes);
        const pages = pdfDoc.getPages();

        for (const page of pages) {
            const { width: pageWidth, height: pageHeight } = page.getSize();

            // Calculate the dimensions and position of the rectangle
            const rectX = leftMargin;
            const rectY = pageHeight - topMargin - overlayHeight;
            const rectWidth = pageWidth - leftMargin - rightMargin;
            const rectHeight = overlayHeight;

            // Ensure width is not negative if margins are too large
            if (rectWidth < 0) {
                console.warn(`⚠️  Margins (${leftMarginCm}cm + ${rightMarginCm}cm) are wider than the page. Overlay will not be drawn for this page.`);
                continue; // Skip drawing on this page
            }

            page.drawRectangle({
                x: rectX,
                y: rectY,
                width: rectWidth,
                height: rectHeight,
                color: rgb(1, 1, 1), // White
                borderWidth: 0,
            });
        }

        const pdfBytes = await pdfDoc.save();
        await fs.writeFile(outputPdfPath, pdfBytes);
        console.log(`✅ Overlay added successfully. Saved to ${outputPdfPath}`);
    } catch (error) {
        console.error(`❌ Failed to add white overlay to ${path.basename(inputPdfPath)}:`, error);
        // Fallback: copy the original file to the output path so the process can continue
        await fs.copyFile(inputPdfPath, outputPdfPath);
        console.warn(`⚠️ Copied original PDF to output path as a fallback.`);
    }
}

async function mergePdfs(pdfPaths, outputPath) {
    if (pdfPaths.length === 0) return;
    const command = `pdftk ${pdfPaths.map(p => `"${p}"`).join(' ')} cat output "${outputPath}"`;
    await execPromise(command);
}

async function compressPdf(inputPath, outputPath) {
    const command = `gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${outputPath}" "${inputPath}"`;
    try {
        console.log(`🗜️  Compressing PDF: ${path.basename(inputPath)}`);
        await execPromise(command);
        console.log(`✅ Compression successful. Output: ${outputPath}`);
    } catch (error) {
        console.error(`❌ Ghostscript compression failed for ${path.basename(inputPath)}.`);
        console.error('--- STDOUT ---');
        console.error(error.stdout);
        console.error('--- STDERR ---');
        console.error(error.stderr);
        throw new Error(`Ghostscript compression failed. See logs above.`);
    }
}

async function fetchImage(url) {
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to fetch image: ${url}`);
        const arrayBuffer = await res.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        // Convert to PNG to ensure transparency
        return await sharp(buffer).toFormat('png').toBuffer();
    } catch (err) {
        console.warn("⚠️ Could not fetch or convert photo:", url, err.message);
        return null;
    }
}

async function readImageBufferFromSource(url) {
    if (!url) return null;

    if (typeof url === 'string' && url.startsWith('file://')) {
        const actualPath = url.replace(/^file:\/\//, '');
        try {
            const fileBuffer = await fs.readFile(actualPath);
            return await sharp(fileBuffer).toFormat('png').toBuffer();
        } catch (err) {
            console.warn(`⚠️ Could not read local image: ${actualPath}`, err.message);
            return null;
        }
    }

    if (typeof url === 'string' && url.startsWith('data:')) {
        try {
            const base64 = url.split(',')[1];
            const buffer = Buffer.from(base64, 'base64');
            return await sharp(buffer).toFormat('png').toBuffer();
        } catch (err) {
            console.warn(`⚠️ Could not convert data URL image:`, err.message);
            return null;
        }
    }

    return fetchImage(url);
}

function normalizeChartKey(value = '') {
    return String(value)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');
}

function readNumericValue(rawValue) {
    if (rawValue === null || rawValue === undefined || rawValue === '') return null;
    if (typeof rawValue === 'number') return Number.isFinite(rawValue) ? rawValue : null;
    const cleaned = String(rawValue).trim().replace(/%/g, '').replace(/,/g, '');
    if (!cleaned || cleaned === '-' || cleaned === 'ABS' || cleaned.toLowerCase() === 'na') return null;
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : null;
}

function classifyTableGroupKey(groupKey = '') {
    const key = normalizeChartKey(groupKey);
    const rules = [
        { label: 'PT I', aliases: ['pti', 'pt1', 'p1', 'periodic1', 'firstperiodictest', 'pti1', 'periodicone', 'p1_'] },
        { label: 'TERM I', aliases: ['termi', 'term1', 't1', 'firstterm', 'termone', 'termi1', 'term_i', 't1_'] },
        { label: 'PT II', aliases: ['ptii', 'pt2', 'p2', 'periodic2', 'secondperiodictest', 'ptii2', 'periodictwo', 'p2_'] },
        { label: 'TERM II', aliases: ['termii', 'term2', 't2', 'secondterm', 'termtwo', 'termii2', 'term_ii', 't2_'] },
        { label: 'OVER ALL', aliases: ['overall', 'grandpercentage', 'overallpercentage', 'totalpercentage', 'weightedgrandpercentage', 'weightedpercentage', 'final', 'finalpercentage'] }
    ];

    for (const rule of rules) {
        if (rule.aliases.some(alias => key === alias || key.includes(alias))) {
            return rule.label;
        }
    }

    if (key.includes('pt') && key.includes('1') && !key.includes('term')) return 'PT I';
    if (key.includes('term') && key.includes('1')) return 'TERM I';
    if (key.includes('pt') && key.includes('2') && !key.includes('term')) return 'PT II';
    if (key.includes('term') && key.includes('2')) return 'TERM II';
    if (key.includes('overall') || key.includes('grand') || key.includes('final')) return 'OVER ALL';

    return null;
}

function extractGroupedChartValues(subject = {}) {
    const result = {
        'PT I': 0,
        'TERM I': 0,
        'PT II': 0,
        'TERM II': 0,
        'OVER ALL': 0
    };

    if (!subject || typeof subject !== 'object') return result;
    // 1) Scan all group rows (ae, pt, etc.) for pt1/pt2/t1/t2 keys. Many templates put PTs inside the 'ae' row.
    const groups = subject.groups || {};
    for (const [groupKey, groupData] of Object.entries(groups)) {
        if (!groupData || typeof groupData !== 'object') continue;

        // Prefer explicit keys if present
        const g_pt1 = readNumericValue(groupData.pt1) ?? readNumericValue(groupData.pt_1) ?? readNumericValue(groupData.p1);
        const g_pt2 = readNumericValue(groupData.pt2) ?? readNumericValue(groupData.pt_2) ?? readNumericValue(groupData.p2);
        const g_t1 = readNumericValue(groupData.t1) ?? readNumericValue(groupData.term1) ?? readNumericValue(groupData.term_1) ?? readNumericValue(groupData.t_1);
        const g_t2 = readNumericValue(groupData.t2) ?? readNumericValue(groupData.term2) ?? readNumericValue(groupData.term_2) ?? readNumericValue(groupData.t_2);

        if ((result['PT I'] === 0 || result['PT I'] === null) && g_pt1 !== null) result['PT I'] = g_pt1;
        if ((result['PT II'] === 0 || result['PT II'] === null) && g_pt2 !== null) result['PT II'] = g_pt2;
        if ((result['TERM I'] === 0 || result['TERM I'] === null) && g_t1 !== null) result['TERM I'] = g_t1;
        if ((result['TERM II'] === 0 || result['TERM II'] === null) && g_t2 !== null) result['TERM II'] = g_t2;

        // Also accept percentage field from the group as fallback for term/PT
        if ((result['TERM I'] === 0 || result['TERM I'] === null) && readNumericValue(groupData.percentage) !== null) {
            // if group key looks like a term, map it
            const k = normalizeChartKey(groupKey);
            if (k.includes('t1') || k.includes('term1') || k.includes('term_i') || k.includes('termone')) {
                result['TERM I'] = readNumericValue(groupData.percentage);
            }
        }
    }

    // 2) Fallback: scan subject top-level keys for pattern matches (ae_eng_pt1, ae_eng_pt2, etc.)
    for (const key of Object.keys(subject)) {
        const lower = String(key).toLowerCase();
        if (lower.endsWith('pt1') || lower.endsWith('_pt1')) {
            const val = readNumericValue(subject[key]);
            if (val !== null && (result['PT I'] === 0 || result['PT I'] === null)) result['PT I'] = val;
        }
        if (lower.endsWith('pt2') || lower.endsWith('_pt2')) {
            const val = readNumericValue(subject[key]);
            if (val !== null && (result['PT II'] === 0 || result['PT II'] === null)) result['PT II'] = val;
        }
        if (lower.endsWith('t1') || lower.endsWith('_t1') || lower.endsWith('term1')) {
            const val = readNumericValue(subject[key]);
            if (val !== null && (result['TERM I'] === 0 || result['TERM I'] === null)) result['TERM I'] = val;
        }
        if (lower.endsWith('t2') || lower.endsWith('_t2') || lower.endsWith('term2')) {
            const val = readNumericValue(subject[key]);
            if (val !== null && (result['TERM II'] === 0 || result['TERM II'] === null)) result['TERM II'] = val;
        }
    }

    // 3) OVER ALL: prefer grandPercentage, else grandTotal
    const overallFromPercentage = readNumericValue(subject.grandPercentage) ?? readNumericValue(subject.weightedGrandPercentage) ?? readNumericValue(subject.weightedPercentage) ?? readNumericValue(subject.percentage);
    const overallFromTotal = readNumericValue(subject.grandTotal) ?? readNumericValue(subject.grandTotal_raw) ?? readNumericValue(subject.total);
    result['OVER ALL'] = overallFromPercentage !== null ? overallFromPercentage : (overallFromTotal !== null ? overallFromTotal : 0);

    return result;
}

function getValueForSeriesKey(subject, key) {
    if (!subject || typeof subject !== 'object') return 0;
    const lk = String(key || '').toLowerCase();
    if (lk === 'overall' || lk === 'over_all' || lk === 'overall_percentage') {
        return readNumericValue(subject.grandPercentage) ?? readNumericValue(subject.weightedGrandPercentage) ?? readNumericValue(subject.weightedPercentage) ?? 0;
    }

    // 1. search group rows
    const groups = subject.groups || {};
    for (const groupData of Object.values(groups)) {
        if (groupData && typeof groupData === 'object') {
            if (groupData.hasOwnProperty(key)) {
                const v = readNumericValue(groupData[key]); if (v !== null) return v;
            }
            // try variations
            const compact = key.replace(/_/g, '');
            if (groupData.hasOwnProperty(compact)) { const v = readNumericValue(groupData[compact]); if (v !== null) return v; }
        }
    }

    // 2. top-level
    if (subject.hasOwnProperty(key)) { const v = readNumericValue(subject[key]); if (v !== null) return v; }

    // 3. aggregated totals ending with _total
    for (const k of Object.keys(subject)) {
        if (k.toLowerCase().endsWith((key + '_total').toLowerCase()) || k.toLowerCase().endsWith((key + 'total').toLowerCase())) {
            const v = readNumericValue(subject[k]); if (v !== null) return v;
        }
    }

    return 0;
}

function humanizeSeriesKey(k = '') {
    if (!k) return '';
    const s = String(k).toLowerCase();
    if (s === 'pt1') return 'PT I';
    if (s === 'pt2') return 'PT II';
    if (s === 't1' || s === 'term1') return 'TERM I';
    if (s === 't2' || s === 'term2') return 'TERM II';
    if (s === 'overall' || s === 'over_all') return 'OVER ALL';
    return String(k).replace(/[_\-]/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());
}

function buildStudentBarChartSvg(subjects = [], detectedSeries = null) {
    // detectedSeries: array of keys like ['pt1','t1','pt2','t2','overall']
    const defaultSeriesKeys = ['pt1', 't1', 'pt2', 't2', 'overall'];
    const seriesKeys = Array.isArray(detectedSeries) && detectedSeries.length > 0 ? detectedSeries : defaultSeriesKeys;
    const palette = ['#3f6fb5', '#f28c28', '#2f9e44', '#db4b2a', '#7f3fbf', '#4a90e2', '#f2b233', '#9b59b6'];

    // Filter series to only those present in the subjects data (at least one numeric value)
    function hasNumericForSeries(subject, key) {
        if (!subject || typeof subject !== 'object') return false;
        // Check groups for numeric values
        const groups = subject.groups || {};
        for (const groupData of Object.values(groups)) {
            if (!groupData || typeof groupData !== 'object') continue;
            // direct key
            if (groupData.hasOwnProperty(key) && readNumericValue(groupData[key]) !== null) return true;
            // variations
            const compact = key.replace(/_/g, '');
            if (groupData.hasOwnProperty(compact) && readNumericValue(groupData[compact]) !== null) return true;
            // percentage
            if (groupData.hasOwnProperty('percentage') && readNumericValue(groupData.percentage) !== null) return true;
        }
        // Check top-level subject keys
        if (subject.hasOwnProperty(key) && readNumericValue(subject[key]) !== null) return true;
        // variations
        const variations = [key, key.replace(/_/g, ''), key + '_total', key + 'total'];
        for (const v of variations) {
            for (const k of Object.keys(subject)) {
                if (k.toLowerCase() === String(v).toLowerCase() && readNumericValue(subject[k]) !== null) return true;
            }
        }
        // overall checks
        if (String(key).toLowerCase().includes('overall') && (readNumericValue(subject.grandPercentage) !== null || readNumericValue(subject.weightedGrandPercentage) !== null || readNumericValue(subject.percentage) !== null)) return true;
        return false;
    }

    const availableSeriesKeys = seriesKeys.filter(k => (subjects || []).some(sub => hasNumericForSeries(sub, k)));
    const series = availableSeriesKeys.map((k, i) => ({ key: k, name: (k === 'overall' ? 'OVER ALL' : humanizeSeriesKey(k)), color: palette[i % palette.length] }));
    console.log(`ℹ️ buildStudentBarChartSvg: using series: ${JSON.stringify(series.map(s => ({ key: s.key, name: s.name })))}`);

    const validSubjects = (subjects || [])
        .filter(item => item && item.name)
        .map(item => {
            const subjectName = String(item.name).trim() || 'Subject';
            const values = series.map(s => getValueForSeriesKey(item, s.key) || 0);
            console.log(`ℹ️ buildStudentBarChartSvg: subject="${subjectName}" values=${JSON.stringify(series.map((s, i) => ({ key: s.key, value: values[i] })))}`);
            return { name: subjectName, values };
        })
        .filter(subject => subject.values.some(v => Number(v) > 0))
        .slice(0, 8);

    const width = 920;
    const height = 420;
    const margin = { top: 20, right: 180, bottom: 60, left: 60 };
    const chartWidth = width - margin.left - margin.right;
    const chartHeight = height - margin.top - margin.bottom;

    if (validSubjects.length === 0) {
        return `
            <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
                <rect width="100%" height="100%" fill="#ffffff"/>
                <text x="50%" y="50%" font-size="20" text-anchor="middle" fill="#111">No chart data available</text>
            </svg>
        `;
    }

    const groupWidth = chartWidth / validSubjects.length;
    const intraGroupPadding = 12;
    const barWidth = series.length > 0 ? (groupWidth - intraGroupPadding) / series.length : 0;

    const gridLines = Array.from({ length: 11 }, (_, index) => {
        const y = margin.top + (chartHeight / 10) * index;
        const labelValue = 100 - (index * 10);
        return `
            <line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="#b7b7b7" stroke-width="1" />
            <text x="${margin.left - 10}" y="${y + 4}" font-size="12" text-anchor="end" fill="#111">${labelValue}</text>
        `;
    }).join('');

    const subjectBars = validSubjects.map((subject, subjectIndex) => {
        const groupX = margin.left + subjectIndex * groupWidth + 10;

            const bars = subject.values.map((value, seriesIndex) => {
            const x = groupX + seriesIndex * barWidth + 2;
            const barHeight = (Number(value) / 100) * chartHeight;
            const y = margin.top + chartHeight - barHeight;
            return `
                <rect x="${x}" y="${y}" width="${barWidth - 4}" height="${barHeight}" fill="${series[seriesIndex].color}" stroke="#000" stroke-width="0.6" />
            `;
        }).join('');

        const labelText = subject.name.length > 12 ? subject.name.substring(0, 12) : subject.name;
        return `
            <g>
                ${bars}
                <text x="${groupX + (groupWidth / 2) - 10}" y="${height - 22}" font-size="14" text-anchor="middle" font-weight="700" fill="#111">${labelText}</text>
            </g>
        `;
    }).join('');

    const legend = series.map((item, index) => `
        <g transform="translate(${width - 130}, ${margin.top + index * 26})">
            <rect x="0" y="0" width="14" height="14" fill="${item.color}" stroke="#000" stroke-width="0.8" />
            <text x="22" y="12" font-size="13" font-weight="700" fill="#111">${item.name}</text>
        </g>
    `).join('');

    return `
        <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
            <rect width="100%" height="100%" fill="#ffffff" />
            <line x1="${margin.left}" y1="${margin.top + chartHeight}" x2="${width - margin.right}" y2="${margin.top + chartHeight}" stroke="#111" stroke-width="1.2" />
            <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + chartHeight}" stroke="#111" stroke-width="1.2" />
            ${gridLines}
            ${subjectBars}
            ${legend}
        </svg>
    `;
}

async function generateStudentBarChartImage(student, transformedData, tempDir, detectedSeries = null) {
    const subjectRows = Array.isArray(transformedData?.subjects) ? transformedData.subjects : [];
    const chartSvg = buildStudentBarChartSvg(subjectRows, detectedSeries);
    const safeName = `${student.full_name?.replace(/\s+/g, '_') || 'student'}_${student.student_id || 'chart'}`;
    const chartPath = path.join(tempDir, `${safeName}_chart.png`);

    try {
        const pngBuffer = await sharp(Buffer.from(chartSvg)).png().toBuffer();
        await fs.writeFile(chartPath, pngBuffer);
        return chartPath;
    } catch (error) {
        console.warn(`⚠️ Failed to create chart for ${student.full_name}:`, error.message);
        return null;
    }
}

async function waitForFile(filePath, retries = 5, delay = 100) {
    for (let i = 0; i < retries; i++) {
        try {
            await fs.access(filePath);
            return true;
        } catch (err) {
            if (err.code === 'ENOENT' && i < retries - 1) {
                console.log(`⌛ Waiting for ${filePath} to be available (${i + 1}/${retries})...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                throw err;
            }
        }
    }
    return false;
}

async function findImageFilename(contentXmlPath, picturesDir, frameName) {
    try {
        const contentXml = await fs.readFile(contentXmlPath, 'utf-8');
        const parsedXml = await parseXml(contentXml, {
            explicitArray: false,
            ignoreAttrs: false,
            mergeAttrs: true,
            normalizeTags: false,
            explicitChildren: true,
            preserveChildrenOrder: true
        });

        console.log(`DEBUG: Starting search for draw:image with draw:name="${frameName}"`);

        function findFrames(node) {
            let frames = [];
            if (typeof node !== 'object' || node === null) return frames;

            if (node['draw:frame']) {
                const frame = node['draw:frame'];
                if (Array.isArray(frame)) {
                    frames.push(...frame);
                } else {
                    frames.push(frame);
                }
            }

            for (const key in node) {
                if (Object.prototype.hasOwnProperty.call(node, key)) {
                    if (Array.isArray(node[key])) {
                        node[key].forEach(child => {
                            frames.push(...findFrames(child));
                        });
                    } else if (typeof node[key] === 'object') {
                        frames.push(...findFrames(node[key]));
                    }
                }
            }
            return frames;
        }

        const textContent = parsedXml['office:document-content']?.['office:body']?.['office:text'] || {};
        const drawFrames = findFrames(textContent);

        for (const frame of drawFrames) {
            const frameNameValue = frame['draw:name'];
            if (frameNameValue !== frameName) continue;

            const image = frame['draw:image'];
            if (!image) {
                console.warn(`⚠️ Frame "${frameName}" exists but contains no draw:image. Skipping replacement.`);
                return null;
            }

            const href = image['xlink:href'];
            if (href && href.startsWith('Pictures/') && /\.(png|jpg|jpeg)$/i.test(href)) {
                const filename = href.replace('Pictures/', '');
                const filePath = path.join(picturesDir, filename);
                try {
                    await fs.access(filePath);
                    return filename;
                } catch (err) {
                    console.warn(`⚠️ Image ${filename} referenced in content.xml but not found in Pictures directory:`, err.message);
                    return null;
                }
            }

            console.warn(`⚠️ Frame "${frameName}" exists but the image reference is not a valid Pictures file. Skipping replacement.`);
            return null;
        }

        console.warn(`⚠️ No valid image frame named "${frameName}" found in the template. Skipping replacement.`);
        return null;
    } catch (err) {
        console.error(`❌ Failed to parse content.xml or read Pictures directory for ${frameName}:`, err);
        return null;
    }
}

async function replaceImageInOdt(templatePath, student, schoolDetails, tempDir, transformedData = {}) {
    const studentDir = path.join(tempDir, `student_${student.student_id}`);
    await fs.mkdir(studentDir, { recursive: true });

    // Unzip ODT
    const unzipPromise = new Promise((resolve, reject) => {
        yauzl.open(templatePath, { lazyEntries: true }, (err, zipfile) => {
            if (err) return reject(err);
            zipfile.readEntry();
            zipfile.on('entry', async (entry) => {
                const entryPath = path.join(studentDir, entry.fileName);
                if (/\/$/.test(entry.fileName)) {
                    await fs.mkdir(entryPath, { recursive: true });
                    zipfile.readEntry();
                } else {
                    zipfile.openReadStream(entry, async (err, readStream) => {
                        if (err) return reject(err);
                        await fs.mkdir(path.dirname(entryPath), { recursive: true });
                        const writeStream = require('fs').createWriteStream(entryPath);
                        readStream.pipe(writeStream);
                        readStream.on('end', () => zipfile.readEntry());
                        readStream.on('error', reject);
                    });
                }
            });
            zipfile.on('end', () => resolve());
            zipfile.on('error', reject);
        });
    });

    try {
        await unzipPromise;
        console.log(`✅ Unzipped template for ${student.full_name} to ${studentDir}`);
    } catch (err) {
        console.error(`❌ Failed to unzip template for ${student.full_name}:`, err);
        return templatePath; // Return original if unzip fails
    }

    const contentXmlPath = path.join(studentDir, 'content.xml');
    const picturesDir = path.join(studentDir, 'Pictures');
    await fs.mkdir(picturesDir, { recursive: true }); // Ensure Pictures directory exists

    // --- NEW: UNIFIED AND NAME-BASED IMAGE REPLACEMENT LOGIC ---

    // Attempt to detect series order from template table behind the image frame
    let detectedSeries = null;
    try {
        // Use the table named for the chart frame. Default to 'studentBarChart'.
        detectedSeries = await extractSeriesFromTemplate(contentXmlPath, 'studentBarChart');
        if (detectedSeries) console.log(`ℹ️ Detected series from template: ${JSON.stringify(detectedSeries)}`);
    } catch (err) {
        console.warn('⚠️ Series detection failed:', err.message);
    }

    const chartImagePath = await generateStudentBarChartImage(student, transformedData, tempDir, detectedSeries);

    // Define the images we want to replace by their frame name in the ODT
    // and where to find their new URL in our data.
    const imageReplacements = [
        {
            frameName: 'Logo',
            url: schoolDetails.logo,
            description: 'School Logo'
        },
        {
            frameName: 'studentImage',
            url: student.photo,
            description: 'Student Photo'
        },
        {
            frameName: 'studentBarChart',
            url: chartImagePath ? `file://${chartImagePath}` : null,
            description: 'Student Performance Bar Chart'
        },
        {
            frameName: 'BarChart',
            url: chartImagePath ? `file://${chartImagePath}` : null,
            description: 'Bar Chart'
        },
        {
            frameName: 'marksChart',
            url: chartImagePath ? `file://${chartImagePath}` : null,
            description: 'Marks Chart'
        },
        {
            frameName: 'studentChart',
            url: chartImagePath ? `file://${chartImagePath}` : null,
            description: 'Student Chart'
        }
    ];

    if (schoolDetails.signatures && typeof schoolDetails.signatures === 'object') {
        for (const key in schoolDetails.signatures) {
            if (Object.prototype.hasOwnProperty.call(schoolDetails.signatures, key)) {
                const signatureInfo = schoolDetails.signatures[key];
                if (signatureInfo && signatureInfo.url) {
                    imageReplacements.push({
                        frameName: key,
                        url: signatureInfo.url,
                        description: signatureInfo.name || `Signature ${key}`
                    });
                }
            }
        }
    }

    let anyImageReplaced = false;

    // Process each potential image replacement
    for (const replacement of imageReplacements) {
        const { frameName, url, description } = replacement;

        if (!url || (!String(url).startsWith("http") && !String(url).startsWith("file://") && !String(url).startsWith("data:"))) {
            continue;
        }

        const targetFilename = await findImageFilename(contentXmlPath, picturesDir, frameName);
        if (!targetFilename) {
            console.warn(`⚠️ Skipping ${description} (${frameName}): no valid image frame was found in the template.`);
            continue;
        }

        console.log(`➡️  Mapping frame "${frameName}" to file "${targetFilename}" for replacement.`);

        const imageBuffer = await readImageBufferFromSource(url);
        if (!imageBuffer) {
            console.warn(`⚠️ Failed to read image for ${description} from ${url}. Skipping replacement.`);
            continue;
        }

        try {
            const imagePath = path.join(picturesDir, targetFilename);
            await fs.writeFile(imagePath, imageBuffer);
            console.log(`✅ Replaced ${description} (${frameName})`);
            anyImageReplaced = true;
        } catch (writeError) {
            console.error(`❌ Failed to write new image for ${description} to ${targetFilename}:`, writeError);
        }
    }

    if (anyImageReplaced) {
        try {
            await execPromise(`xmllint --format "${contentXmlPath}" -o "${contentXmlPath}"`);
            await normalizeTextSpans(contentXmlPath);
            console.log(`✅ Formatted content.xml for ${student.full_name}`);
        } catch (err) {
            console.warn(`⚠️ xmllint formatting failed: ${err.message}. Using unformatted content.xml.`);
        }
    } else {
        console.log(`ℹ️ No images were replaced for ${student.full_name}.`);
    }

    // --- END OF NEW LOGIC ---

    // Re-zip to create new ODT
    // const safeName = student.full_name?.replace(/\s+/g, '_') || student.student_id; // removed for fixing duplicate name issue
    const safeName = `${student.full_name?.replace(/\s+/g, '_') || 'student'}_${student.student_id}`;
    const newOdtPath = path.join(tempDir, `${safeName}.odt`);
    const zip = new yazl.ZipFile();
    const walkDir = async (dir, zipPath = '') => {
        const files = await fs.readdir(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            const stats = await fs.stat(fullPath);
            const zipEntry = path.join(zipPath, file);
            if (stats.isDirectory()) {
                await walkDir(fullPath, zipEntry);
            } else {
                zip.addFile(fullPath, zipEntry);
            }
        }
    };

    try {
        await walkDir(studentDir);
        const writeStream = require('fs').createWriteStream(newOdtPath);
        zip.outputStream.pipe(writeStream);
        await new Promise((resolve, reject) => {
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
            zip.end();
        });
        console.log(`✅ Zipped new ODT for ${student.full_name} at ${newOdtPath}`);

        const fileExists = await waitForFile(newOdtPath);
        if (!fileExists) {
            throw new Error(`File ${newOdtPath} was not created or accessible after zipping`);
        }
        return newOdtPath;
    } catch (err) {
        console.error(`❌ Failed to re-zip ODT for ${student.full_name}:`, err);
        return templatePath;
    }
}

function cleanData(data) {
    if (data === null || data === undefined || (typeof data === 'number' && isNaN(data))) {
        return '';
    }
    if (Array.isArray(data)) {
        return data.map(item => cleanData(item));
    }
    if (typeof data === 'object') {
        const cleanedObject = {};
        for (const key in data) {
            if (Object.prototype.hasOwnProperty.call(data, key)) {
                if (data[key] === 'NaN') {
                    cleanedObject[key] = '';
                } else {
                    cleanedObject[key] = cleanData(data[key]);
                }
            }
        }
        return cleanedObject;
    }
    return data;
}

// --- MAIN FUNCTION ---
async function GenerateOdtFile() {
    let outputDir = '';
    let tempDir = '';
    const jobId = process.env.JOB_ID;
    const schoolId = process.env.SCHOOL_ID;

    try {
        console.log("🚀 Starting dynamic marksheet generation with Carbone...");

        const groupid = process.env.GROUP_ID;
        const batchId = process.env.BATCH_ID;
        const courseId = process.env.COURSE_ID;
        const RANKING_ID = process.env.RANKING_ID;
        const DIVISION_ID = process.env.DIVISION_ID;
        const templateUrl = process.env.TEMPLATE_URL;
        const groupIds = groupid?.split(",");
        const studentIdsInput = process.env.STUDENT_IDS;
        // --- IMPROVED: Safely parse TEMPLATE_HEADER with better error handling ---
        let templateHeader = {
            show_header: true,
            margins: { heightCm: 5, topMarginCm: 0, leftMarginCm: 0, rightMarginCm: 0 }
        };

        if (process.env.TEMPLATE_HEADER) {
            console.log(`🔍 Raw TEMPLATE_HEADER value: "${process.env.TEMPLATE_HEADER}"`);

            let fixedJson = process.env.TEMPLATE_HEADER.trim().replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*):/g, '$1"$2":');

            console.log(`🔧 Fixed TEMPLATE_HEADER attempt: "${fixedJson}"`);

            try {
                templateHeader = JSON.parse(fixedJson);
                console.log(`✅ Successfully parsed TEMPLATE_HEADER:`, templateHeader);

                // Ensure we have valid structure
                if (typeof templateHeader.show_header !== 'boolean') {
                    console.warn(`⚠️ Invalid show_header value. Defaulting to true.`);
                    templateHeader.show_header = true;
                }

                if (!templateHeader.margins || typeof templateHeader.margins !== 'object') {
                    console.warn(`⚠️ Invalid margins structure. Using defaults.`);
                    templateHeader.margins = { heightCm: 5, topMarginCm: 0, leftMarginCm: 0, rightMarginCm: 0 };
                }

            } catch (parseError) {
                console.error(`❌ Failed to parse TEMPLATE_HEADER:`, parseError.message);

                templateHeader = {
                    show_header: true,
                    margins: { heightCm: 5, topMarginCm: 0, leftMarginCm: 0, rightMarginCm: 0 }
                };
            }
        }

        const applyOverlay = !templateHeader.show_header;
        const overlayOptions = {
            heightCm: templateHeader.margins.heightCm || 5,
            topMarginCm: templateHeader.margins.topMarginCm || 0,
            leftMarginCm: templateHeader.margins.leftMarginCm || 0,
            rightMarginCm: templateHeader.margins.rightMarginCm || 0
        };

        console.log(`🎯 Template header config: show_header=${templateHeader.show_header}, applyOverlay=${applyOverlay}`);

        if (!templateUrl || !schoolId || !batchId || !jobId || !courseId || !groupIds) {
            throw new Error('❌ Missing required environment variables.');
        }

        outputDir = path.join(process.cwd(), 'output');
        await fs.mkdir(outputDir, { recursive: true });
        tempDir = path.join(outputDir, 'temp');
        await fs.mkdir(tempDir, { recursive: true });
        const pdfPaths = [];

        // Fetch School Details
        console.log("🏫 Fetching school details...");
        const schoolDetailsPayload = { school_id: schoolId };
        const schoolDetailsResponse = await fetch('https://demoschool.edusparsh.com/api/get_School_Detail', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(schoolDetailsPayload),
        });
        if (!schoolDetailsResponse.ok) throw new Error(`Failed to fetch school details: ${await schoolDetailsResponse.text()}`);
        let schoolDetails = cleanData(await schoolDetailsResponse.json());

        // ✨ NEW: Parse signature config from schoolDetails
        let signatureConfig = {};
        if (schoolDetails.config && typeof schoolDetails.config === 'string') {
            try {
                signatureConfig = JSON.parse(schoolDetails.config);
                console.log("✅ Parsed signature config from school details.");
            } catch (e) {
                console.warn("⚠️ Could not parse schoolDetails.config JSON for signatures:", e.message);
            }
        }
        schoolDetails.signatures = signatureConfig; // Attach for easy access

        console.log("✅ School details fetched successfully.");

        console.log("⚙️ Fetching student details configuration...");
        let studentDetailsConfigFromApi = null;

        /* -------------------- TRY NEW API FIRST -------------------- */
        try {
            const configPayload = {
                school_id: schoolId,
                course_id: courseId,
                config_type: 'student_details_config'
            };

            const configResponse = await fetch(
                'https://demoschool.edusparsh.com/api/gettempletemetedata',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(configPayload),
                }
            );

            if (configResponse.ok) {
                const configData = await configResponse.json();



                if (configData && configData.config_value) {
                    studentDetailsConfigFromApi =
                        typeof configData.config_value === 'object'
                            ? JSON.stringify(configData.config_value)
                            : configData.config_value;

                    console.log("✅ Config loaded from NEW template metadata API.");

                } else {
                    console.warn("⚠️ New API returned no config_value. Will fallback.");
                }
            } else {
                console.warn(`⚠️ New API failed (${configResponse.statusText}). Will fallback.`);
            }
        } catch (configError) {
            console.warn(`⚠️ Error calling new API: ${configError.message}. Will fallback.`);
        }

        /* -------------------- FALLBACK TO OLD API -------------------- */
        if (!studentDetailsConfigFromApi) {
            console.log("↩️ Falling back to old configuration API...");

            try {
                const configPayload = {
                    _school: schoolId,
                    config_key: 'student_details_config'
                };

                const configResponse = await fetch(
                    'https://demoschool.edusparsh.com/api/getConfiguration',
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(configPayload),
                    }
                );

                if (configResponse.ok) {
                    const configData = await configResponse.json();

                    if (configData && configData.config_value) {
                        studentDetailsConfigFromApi = configData.config_value;
                        console.log("✅ Loaded config from OLD API.");

                    } else {
                        console.warn("⚠️ Old API also returned no config.");
                    }
                } else {
                    console.warn(`⚠️ Old API failed (${configResponse.statusText}).`);
                }
            } catch (configError) {
                console.warn(`⚠️ Old API error: ${configError.message}.`);
            }
        }

        // --- NEW: FETCH NAMING CONVENTION CONFIG ---
        console.log("⚙️ Fetching naming convention configuration...");
        let namingConvention = null;
        try {
            const configPayload = {
                _school: schoolId,
                config_key: 'NamingConvention'
            };
            const configResponse = await fetch('https://demoschool.edusparsh.com/api/getConfiguration', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(configPayload),
            });
            if (configResponse.ok) {
                const configData = await configResponse.json();
                if (configData && configData.config_value) {
                    namingConvention = configData.config_value;
                    console.log(`✅ Successfully fetched NamingConvention: "${namingConvention}"`);
                } else {
                    console.warn("⚠️ NamingConvention config fetched, but 'config_value' is missing.");
                }
            } else {
                console.warn(`⚠️ API failed to fetch NamingConvention config (${configResponse.statusText}).`);
            }
        } catch (configError) {
            console.warn(`⚠️ Error fetching NamingConvention config: ${configError.message}.`);
        }
        // --- END OF NEW FETCH ---

        if (schoolDetails.logo && typeof schoolDetails.logo === 'string') {
            schoolDetails.logo = `https://schoolerp-bucket.blr1.cdn.digitaloceanspaces.com/supa-img/${schoolId}/${schoolDetails.logo}`;
            console.log(`✅ Transformed school logo to: ${schoolDetails.logo}`);
        } else {
            console.warn(`⚠️ School logo not found or invalid.`);
        }

        const marksPayload = {
            _school: schoolId,
            batchId: [batchId],
            group: groupIds,
            currentdata: { division_id: DIVISION_ID, ranking_id: RANKING_ID }
        };

        // Determine which API to call. If we have specific students (Previous Year), use studentWiseMarks.
        let fetchUrl = 'https://demoschool.edusparsh.com/api/cce_examv1/getMarks';

        if (studentIdsInput) {
            const sIds = studentIdsInput.split(',');
            marksPayload.student_ids = sIds;
            marksPayload.student_id = sIds; // Add this key as studentWiseMarks often expects 'student_id'
            // fetchUrl = 'https://demoschool.edusparsh.com/api/cce_examv1/studentWiseMarks';
            fetchUrl = 'https://demoschool.edusparsh.com/api/cce_examv1/studentWiseMarks';
        }

        console.log("📥 Fetching student data...");
        console.log(fetchUrl);

        const studentResponse = await fetch(fetchUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(marksPayload),
        });

        if (!studentResponse.ok) throw new Error(`Failed to fetch student data: ${await studentResponse.text()}`);
        const studentResponseJson = await studentResponse.json();
        let students = studentResponseJson.students || studentResponseJson.data || [];

        if (studentIdsInput) {
            const requestedStudentIds = new Set(studentIdsInput.split(','));
            students = students.filter(student => student && student.student_id && requestedStudentIds.has(student.student_id));
        }

        students = students.filter(s => s && s.student_id);

        if (students.length === 0) {
            console.warn("⚠️ No valid students found matching criteria. Exiting.");
            await updateJobHistory(jobId, schoolId, { status: true, notes: "Completed: No valid students found." });
            return;
        }
        students = students.map(s => ({ ...s, _uid: s.student_id }));
        console.log(`✅ Found and will process ${students.length} student(s).`);

        console.log("📡 Fetching marksheet config + transformed data...");
        // const apiRes = await fetch('https://demoschool.edusparsh.com/api/marksheetdataodt', {

        // --- MINIMUM CHANGE: Conditional URL based on SCHOOL_ID ---
        const specialSchools = ['seedlingsschool'];
        const marksheetApiUrl = specialSchools.includes(schoolId)
            ? 'https://schoolscoop-supa-git-mkmar2-f89310-school-scoop-indias-projects.vercel.app/api/marksheetdataodt'
            : 'https://demoschool.edusparsh.com/api/marksheetdataodt';


        console.log(`Using marksheet API URL: ${marksheetApiUrl}`);
        const apiRes = await fetch(marksheetApiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                _school: schoolId,
                groupIds,
                batchId,
                studentIds: students.map(s => s.student_id),
                students,
            }),
        });
        if (!apiRes.ok) throw new Error(`Config API failed: ${await apiRes.text()}`);
        const { transformedStudents } = await apiRes.json();
        if (!transformedStudents) throw new Error(`Config API failed: missing transformedStudents.`);
        console.log(`✅ Got transformed data for ${transformedStudents.length} students.`);

        console.log("📥 Downloading template...");
        const templateBuffer = await downloadFile(templateUrl);
        const templatePath = path.join(outputDir, 'template.odt');
        await fs.writeFile(templatePath, templateBuffer);
        console.log(`✅ Template saved locally to: ${templatePath}`);

        for (let i = 0; i < students.length; i++) {
            const student = students[i];
            let transformedData = cleanData(transformedStudents[i]);

            Object.keys(transformedData).forEach(key => {
                if (key.includes('&')) {
                    const safeKey = key.replace(/&/g, '_');
                    transformedData[safeKey] = transformedData[key];
                }
            });

            console.log(`\n--- 📝 Processing student: ${student.full_name} (${i + 1}/${students.length}) ---`);

            const modifiedOdtPath = await replaceImageInOdt(templatePath, student, schoolDetails, tempDir, transformedData);

            const dynamicDetailsConfig = studentDetailsConfigFromApi;
            let details = {};
            for (let j = 1; j <= 25; j++) { details[`label${j}`] = ''; details[`value${j}`] = ''; }

            if (dynamicDetailsConfig && typeof dynamicDetailsConfig === 'string') {
                try {
                    const parsedConfig = JSON.parse(dynamicDetailsConfig);

                    // NEW API format
                    let configArray = [];

                    if (Array.isArray(parsedConfig)) {
                        // Old API format
                        configArray = parsedConfig;
                    } else if (parsedConfig.fields && Array.isArray(parsedConfig.fields)) {
                        // New API format
                        configArray = parsedConfig.fields;
                    }

                    configArray.forEach((item, index) => {
                        const slotNumber = index + 1;

                        if (item.label && item.key) {
                            details[`label${slotNumber}`] = item.label;
                            details[`value${slotNumber}`] = transformedData[item.key] || '';
                        }
                    });
                } catch (e) {
                    console.warn(`⚠️ Could not parse dynamic details config: ${e.message}`);
                }
            }

            if (namingConvention) {
                console.log(`Applying "${namingConvention}" naming convention to student data...`);
                transformedData = applyNamingConvention(transformedData, namingConvention);
                details = applyNamingConvention(details, namingConvention);
            }

            const dataForCarbone = { ...transformedData, school: schoolDetails, details: details };


            if (i === 0) {
                console.log(`\n--- DEBUG: FIRST STUDENT PAYLOAD ---`);
                console.log(JSON.stringify(dataForCarbone, null, 2));
                console.log(`------------------------------------\n`);
            }

            // const fileSafeName = student.full_name?.replace(/\s+/g, '_') || `student_${Date.now()}`; // removed for fixing duplicate name issue
            const fileSafeName = `${student.full_name?.replace(/\s+/g, '_') || 'student'}_${student.student_id}`;
            const odtReport = await carboneRender(modifiedOdtPath, dataForCarbone);
            const odtFilename = path.join(outputDir, `${fileSafeName}.odt`);
            await fs.writeFile(odtFilename, odtReport);

            const originalPdfPath = await convertOdtToPdf(odtFilename, outputDir);
            let finalPdfPath = originalPdfPath;

            if (applyOverlay) {
                const modifiedPdfPath = path.join(outputDir, `${fileSafeName}_modified.pdf`);
                await addWhiteOverlay(originalPdfPath, modifiedPdfPath, overlayOptions);
                finalPdfPath = modifiedPdfPath;
            } else {
                console.log(`📜 Skipping white overlay for ${student.full_name}.`);
            }

            if (!require('fs').existsSync(finalPdfPath)) {
                console.error(`--- ❌ DEBUG DATA that caused failure for ${student.full_name} ---`);
                console.error(JSON.stringify(dataForCarbone, null, 2));
                throw new Error(`PDF generation failed for "${student.full_name}". File not found: ${finalPdfPath}.`);
            }
            console.log(`✅ Successfully created PDF for ${student.full_name}`);
            pdfPaths.push(finalPdfPath);
        }

        if (pdfPaths.length > 0) {
            const mergedPdfPath = path.join(outputDir, 'merged_output.pdf');
            const compressedPdfPath = path.join(outputDir, 'merged_compressed.pdf');

            console.log('🔗 Merging all generated PDFs...');
            await mergePdfs(pdfPaths, mergedPdfPath);
            console.log(`✅ Merged PDF created: ${mergedPdfPath}`);

            await compressPdf(mergedPdfPath, compressedPdfPath);
            const originalSize = (await fs.stat(mergedPdfPath)).size / (1024 * 1024);
            const compressedSize = (await fs.stat(compressedPdfPath)).size / (1024 * 1024);
            console.log(`📊 Compression: Original: ${originalSize.toFixed(2)} MB, Compressed: ${compressedSize.toFixed(2)} MB`);

            const filePath = `templates/marksheets/${schoolId}/result/${batchId}_${jobId}.pdf`;
            const fileBuffer = await fs.readFile(compressedPdfPath);
            const formData = new FormData();
            formData.append('photo', fileBuffer, { filename: 'merged_output.pdf', contentType: 'application/pdf' });
            formData.append('key', filePath);
            formData.append('ContentType', 'application/pdf');
            formData.append('jobId', jobId);

            console.log(`📤 Uploading compressed PDF...`);
            const uploadRes = await fetch('https://demoschool.edusparsh.com/api/uploadfileToDigitalOcean', {
                method: 'POST',
                headers: formData.getHeaders(),
                body: formData,
            });

            if (!uploadRes.ok) throw new Error(`File upload failed: ${await uploadRes.text()}`);
            console.log("✅ File uploaded. Updating job history...");
            await updateJobHistory(jobId, schoolId, { file_path: filePath, status: true });
            console.log('✅ Job history updated.');
        } else {
            console.log('⚠️ No PDFs were generated to merge.');
        }

        console.log("\n🎉 Marksheets generated and uploaded successfully.");
    } catch (error) {
        console.error('❌ FATAL ERROR:', error.message || error);
        if (jobId && schoolId) {
            await updateJobHistory(jobId, schoolId, { status: false, notes: `Failed: ${error.message}`.substring(0, 500) });
        }
        throw error;
    } finally {
        if (tempDir) {
            await fs.rm(tempDir, { recursive: true, force: true }).catch((err) => {
                console.warn(`⚠️ Failed to clean up temp directory: ${err.message}`);
            });
        }
    }
}

// --- EXECUTION ---
GenerateOdtFile();