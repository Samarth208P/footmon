// js/data.js — JSON data loader with LRU-style cache

const DataManager = (() => {
  const cache = {};   // { year: parsed JSON }

  async function loadYear(year) {
    if (cache[year]) return cache[year];
    const res = await fetch(`/data/${year}.json`);
    if (!res.ok) throw new Error(`Failed to load /data/${year}.json`);
    cache[year] = await res.json();
    return cache[year];
  }

  /** Return all nation codes available for a given year */
  async function getNations(year) {
    const data = await loadYear(year);
    return Object.keys(data.nations);
  }

  /** Return the squad array for a nation+year */
  async function getSquad(year, nationCode) {
    const data = await loadYear(year);
    const nation = data.nations[nationCode];
    if (!nation) return null;
    return { name: nation.name, squad: nation.squad };
  }

  /**
   * Roll a random nation+year combination.
   * @param {object} opts
   *   lockYear   {number|null}  – fix year, randomise nation
   *   lockNation {string|null}  – try to keep nation, randomise year
   *   excludeNation {string}   – do not pick this nation code (for re-rolls)
   *   excludeYear   {number}   – do not pick this year (for re-rolls)
   */
  async function roll({ lockYear = null, lockNation = null,
                         excludeNation = null, excludeYear = null } = {}) {

    let year, nationCode, nationName, squad;

    if (lockYear !== null) {
      // Keep year, pick a different nation
      year = lockYear;
      const data   = await loadYear(year);
      let   codes  = Object.keys(data.nations);

      if (codes.length <= 1) {
        // Only one nation in this year – must change year too
        return roll({ lockNation, excludeYear: lockYear });
      }

      if (excludeNation) codes = codes.filter(c => c !== excludeNation);
      if (!codes.length)  codes = Object.keys(data.nations); // fallback

      nationCode = codes[Math.floor(Math.random() * codes.length)];
      nationName = data.nations[nationCode].name;
      squad      = data.nations[nationCode].squad;

    } else if (lockNation !== null) {
      // Keep nation code, pick a different year where that nation exists
      let candidateYears = WC_YEARS.filter(y => y !== excludeYear);

      // Find years that actually have this nation
      let yearsWithNation = [];
      for (const y of candidateYears) {
        const data = await loadYear(y);
        if (data.nations[lockNation]) yearsWithNation.push(y);
      }

      if (yearsWithNation.length === 0) {
        // Nation doesn't exist in any other year – full random
        return roll({ excludeYear });
      }

      year       = yearsWithNation[Math.floor(Math.random() * yearsWithNation.length)];
      const data = await loadYear(year);
      nationCode = lockNation;
      nationName = data.nations[nationCode].name;
      squad      = data.nations[nationCode].squad;

    } else {
      // Full random
      let years = excludeYear ? WC_YEARS.filter(y => y !== excludeYear) : [...WC_YEARS];
      year       = years[Math.floor(Math.random() * years.length)];
      const data = await loadYear(year);
      let codes  = Object.keys(data.nations);
      if (excludeNation) codes = codes.filter(c => c !== excludeNation);
      if (!codes.length)  codes = Object.keys(data.nations);

      nationCode = codes[Math.floor(Math.random() * codes.length)];
      nationName = data.nations[nationCode].name;
      squad      = data.nations[nationCode].squad;
    }

    // Sort squad by rating desc
    squad = [...squad].sort((a, b) => b.rating - a.rating);

    return { year, nationCode, nationName, squad };
  }

  return { loadYear, getNations, getSquad, roll };
})();
