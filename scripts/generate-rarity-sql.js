/**
 * Generate SQL to load punk rarity data from the original CSVs
 * 
 * Usage:
 * 1. Place cryptopunks_traits.csv and punks_rank.csv in this directory
 * 2. Run: node scripts/generate-rarity-sql.js > rarity-data.sql
 * 3. Run the SQL in Supabase SQL Editor
 */

const fs = require('fs');

// Parse CSV helper - handles quoted fields
function parseCSV(content) {
  const lines = content.trim().replace(/\r/g, '').split('\n');
  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
  
  return lines.slice(1).map(line => {
    const values = [];
    let current = '';
    let inQuotes = false;
    
    for (const char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim());
    
    const obj = {};
    headers.forEach((h, i) => obj[h] = values[i] || '');
    return obj;
  });
}

// Main
const traitsPath = process.argv[2] || 'cryptopunks_traits.csv';
const rankPath = process.argv[3] || 'punks_rank.csv';

if (!fs.existsSync(traitsPath) || !fs.existsSync(rankPath)) {
  console.error('Usage: node generate-rarity-sql.js <traits.csv> <rank.csv>');
  console.error('Files not found:', traitsPath, rankPath);
  process.exit(1);
}

const traitsContent = fs.readFileSync(traitsPath, 'utf-8');
const rankContent = fs.readFileSync(rankPath, 'utf-8');

const traits = parseCSV(traitsContent);
const ranks = parseCSV(rankContent);

// Build rank lookup
const rankMap = {};
ranks.forEach(r => {
  rankMap[r.id] = parseInt(r.rank) || 5000;
});

// Generate SQL
console.log('-- Punk Rarity Data');
console.log('-- Generated from cryptopunks_traits.csv and punks_rank.csv');
console.log('');
console.log('TRUNCATE TABLE punk_rarity;');
console.log('');

// Process in batches of 500 for SQL statement size limits
const batchSize = 500;
for (let batch = 0; batch < Math.ceil(traits.length / batchSize); batch++) {
  const start = batch * batchSize;
  const end = Math.min(start + batchSize, traits.length);
  const batchTraits = traits.slice(start, end);
  
  console.log(`INSERT INTO punk_rarity (punk_id, type, attr_count, has_hoodie, has_beanie, rank) VALUES`);
  
  const values = batchTraits.map((punk) => {
    const punkId = parseInt(punk.asset_id);
    const type = (punk.type || 'Male').replace(/'/g, "''"); // Escape quotes
    
    // Find which attribute count column has 1.0
    let attrCount = 3; // default
    for (let i = 0; i <= 7; i++) {
      const colName = `${i} attributes`;
      if (punk[colName] === '1.0' || punk[colName] === '1') {
        attrCount = i;
        break;
      }
    }
    
    const hasHoodie = punk['Hoodie'] === '1.0' || punk['Hoodie'] === '1';
    const hasBeanie = punk['Beanie'] === '1.0' || punk['Beanie'] === '1';
    const rank = rankMap[punkId] || 5000;
    
    return `  (${punkId}, '${type}', ${attrCount}, ${hasHoodie}, ${hasBeanie}, ${rank})`;
  });
  
  console.log(values.join(',\n') + ';');
  console.log('');
}
