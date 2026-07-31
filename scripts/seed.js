const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://kjugoifxigegfokqcwjp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtqdWdvaWZ4aWdlZ2Zva3Fjd2pwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0NjU1MTIsImV4cCI6MjEwMTA0MTUxMn0.QG0QYlnjvF8lnPc6kxt9PZG1CJ-HTF6zg9WD-PGU0yM';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const dataDir = path.join(__dirname, '..', 'public', 'data');

async function seed() {
    console.log('Seeding players...');
    const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.json'));
    
    let totalInserted = 0;
    for (const file of files) {
        const yearMatch = file.match(/^(\d+)\.json$/);
        if (!yearMatch) continue;
        const year = yearMatch[1];
        
        console.log(`Processing year ${year}...`);
        const filePath = path.join(dataDir, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        
        let allPlayers = [];
        
        for (const [nationCode, nationData] of Object.entries(data.nations)) {
            const nationName = nationData.name;
            const teamYear = `${nationName} ${year}`;
            
            for (const player of nationData.squad) {
                // Some players might have multiple positions, we'll join them or take the first
                const position = Array.isArray(player.positions) ? player.positions.join(', ') : (player.positions || 'UNKNOWN');
                
                allPlayers.push({
                    name: player.name,
                    jersey_number: player.jersey_number || 0,
                    rating: player.rating || 50,
                    position: position,
                    is_legendary: player.is_legendary || false,
                    team_year: teamYear
                });
            }
        }
        
        console.log(`Found ${allPlayers.length} players for ${year}. Inserting...`);
        // Batch insert in chunks of 500
        const chunkSize = 500;
        for (let i = 0; i < allPlayers.length; i += chunkSize) {
            const chunk = allPlayers.slice(i, i + chunkSize);
            const { error } = await supabase.from('players').insert(chunk);
            if (error) {
                console.error(`Error inserting chunk for ${year}:`, error);
            } else {
                totalInserted += chunk.length;
                console.log(`Inserted ${chunk.length} players. (Total: ${totalInserted})`);
            }
        }
    }
    console.log('Seeding complete! Total players inserted:', totalInserted);
}

seed().catch(console.error);
