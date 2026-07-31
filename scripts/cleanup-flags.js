const fs = require('fs');
const path = require('path');

const flagsDir = path.join(__dirname, '..', 'public', 'flags');

// Mapping of 46 World Cup nation codes in players.csv to their flag image filenames
const USED_FLAGS = new Set([
    'dz.png',     // ALG - Algeria
    'ar.png',     // ARG - Argentina
    'au.png',     // AUS - Australia
    'at.png',     // AUT - Austria
    'be.png',     // BEL - Belgium
    'br.png',     // BRA - Brazil
    'bg.png',     // BUL - Bulgaria
    'cl.png',     // CHI - Chile
    'ci.png',     // CIV - Ivory Coast
    'cm.png',     // CMR - Cameroon
    'co.png',     // COL - Colombia
    'cr.png',     // CRC - Costa Rica
    'hr.png',     // CRO - Croatia
    'cz.png',     // CZE - Czech Republic
    'dk.png',     // DEN - Denmark
    'ec.png',     // ECU - Ecuador
    'eg.png',     // EGY - Egypt
    'gb-eng.png', // ENG - England
    'es.png',     // ESP - Spain
    'fr.png',     // FRA - France
    'de.png',     // GER - Germany
    'gh.png',     // GHA - Ghana
    'gr.png',     // GRE - Greece
    'ie.png',     // IRL - Ireland
    'it.png',     // ITA - Italy
    'jp.png',     // JPN - Japan
    'kr.png',     // KOR - South Korea
    'ma.png',     // MAR - Morocco
    'mx.png',     // MEX - Mexico
    'nl.png',     // NED - Netherlands
    'ng.png',     // NGA - Nigeria
    'py.png',     // PAR - Paraguay
    'pe.png',     // PER - Peru
    'pl.png',     // POL - Poland
    'pt.png',     // POR - Portugal
    'ro.png',     // ROU - Romania
    'ru.png',     // RUS - Russia
    'gb-sct.png', // SCO - Scotland
    'sn.png',     // SEN - Senegal
    'rs.png',     // SRB - Serbia
    'ch.png',     // SUI - Switzerland
    'se.png',     // SWE - Sweden
    'tr.png',     // TUR - Turkey
    'ua.png',     // UKR - Ukraine
    'uy.png',     // URU - Uruguay
    'us.png'      // USA - United States
]);

if (!fs.existsSync(flagsDir)) {
    console.log('public/flags directory does not exist.');
    process.exit(0);
}

const allFiles = fs.readdirSync(flagsDir);
console.log(`Total flag files before cleanup: ${allFiles.length}`);

let removedCount = 0;
let keptCount = 0;

allFiles.forEach(file => {
    if (USED_FLAGS.has(file.toLowerCase())) {
        keptCount++;
    } else {
        const filePath = path.join(flagsDir, file);
        fs.unlinkSync(filePath);
        removedCount++;
    }
});

console.log(`Cleanup completed! Kept: ${keptCount} used flags. Removed: ${removedCount} unused flags.`);
