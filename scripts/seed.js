const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// Load environment variables from .env.local if present
const envPath = path.join(__dirname, '..', '.env.local');
let url = process.env.NEXT_PUBLIC_SUPABASE_URL;
let key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split('\n').forEach(line => {
        const parts = line.split('=');
        if (parts.length >= 2) {
            const envKey = parts[0].trim();
            const envVal = parts.slice(1).join('=').trim();
            if (envKey === 'NEXT_PUBLIC_SUPABASE_URL' && !url) url = envVal;
            if (envKey === 'NEXT_PUBLIC_SUPABASE_ANON_KEY' && !key) key = envVal;
        }
    });
}

if (!url || !key) {
    console.error('Supabase URL or Key not found in environment or .env.local');
    process.exit(1);
}

const supabase = createClient(url, key);
const csvPath = path.join(__dirname, '..', 'public', 'players.csv');

function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            result.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    result.push(current.trim());
    return result;
}

async function seed() {
    console.log('--- Step 1: Deleting older player data from Supabase ---');
    const { error: deleteError, count: deletedCount } = await supabase
        .from('players')
        .delete({ count: 'exact' })
        .neq('id', '00000000-0000-0000-0000-000000000000');

    if (deleteError) {
        console.error('Error deleting older player data:', deleteError);
        process.exit(1);
    }
    console.log(`Deleted ${deletedCount ?? 'all'} existing rows from 'players' table.`);

    console.log('--- Step 2: Reading and parsing players.csv ---');
    if (!fs.existsSync(csvPath)) {
        console.error('players.csv file not found at:', csvPath);
        process.exit(1);
    }

    const fileContent = fs.readFileSync(csvPath, 'utf8');
    const lines = fileContent.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    
    if (lines.length <= 1) {
        console.error('No player data found in players.csv');
        process.exit(1);
    }

    const header = parseCSVLine(lines[0]);
    console.log('CSV Header:', header);

    const playersToInsert = [];
    for (let i = 1; i < lines.length; i++) {
        const cols = parseCSVLine(lines[i]);
        if (cols.length < header.length) continue;
        
        const [nation, worldCupYear, playerName, playerId, jerseyNumber, rating, position, attack, defense, isLegendary] = cols;
        
        const formattedPosition = position ? position.replace(/\//g, ', ') : 'UNKNOWN';
        const teamYear = `${nation} ${worldCupYear}`;
        
        playersToInsert.push({
            name: playerName,
            jersey_number: parseInt(jerseyNumber, 10) || 0,
            rating: parseInt(rating, 10) || 50,
            position: formattedPosition,
            is_legendary: isLegendary ? isLegendary.toLowerCase() === 'true' : false,
            team_year: teamYear
        });
    }

    console.log(`Parsed ${playersToInsert.length} valid players from CSV.`);

    console.log('--- Step 3: Inserting players into Supabase in batches ---');
    const chunkSize = 500;
    let totalInserted = 0;

    for (let i = 0; i < playersToInsert.length; i += chunkSize) {
        const chunk = playersToInsert.slice(i, i + chunkSize);
        const { error: insertError, data } = await supabase.from('players').insert(chunk).select('id');
        
        if (insertError) {
            console.error(`Error inserting batch at offset ${i}:`, insertError);
            process.exit(1);
        } else {
            const countInserted = data ? data.length : chunk.length;
            totalInserted += countInserted;
            console.log(`Inserted batch ${Math.floor(i / chunkSize) + 1} (${countInserted} rows). Total so far: ${totalInserted}`);
        }
    }

    console.log(`\n=== Seeding successful! Total players inserted into Supabase: ${totalInserted} ===`);
}

seed().catch(err => {
    console.error('Fatal error during seeding:', err);
    process.exit(1);
});
