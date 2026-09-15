import type { JurisdictionProfile } from "./types";

/**
 * Per-jurisdiction search data: the authority tiers the ranker reads, the
 * topic→regulator lead rules, the junk markers, the byte-stable system
 * instruction, the query-enrichment cue, and the citation→URL builders.
 *
 * Singapore is ported in full from Casey
 * (`services/agentic_chat/web_search/{sg_legal_sources,legal_sources,gemini_grounding}.py`
 * and `tools/web_search_tool.py`). The other jurisdictions deliberately carry
 * only their primary-source domains: no topic rules, no citation builders and
 * no junk lists were ever validated for them.
 */
export interface TopicRegulatorRule {
    /** Non-global (stateless) matcher run against the query plus result titles. */
    readonly pattern: RegExp;
    /** The administering body's own domain, boosted to the lead. */
    readonly domain: string;
}

export interface CitationTarget {
    readonly citation: string;
    readonly url: string;
}

export interface JurisdictionSources {
    readonly profile: JurisdictionProfile;
    /** Primary authority — statutes and courts. Ranked "official". */
    readonly officialDomains: readonly string[];
    /** Official secondary bodies that do not sit on a ".gov" host. Ranked "government". */
    readonly governmentDomains: readonly string[];
    readonly topicRegulatorRules: readonly TopicRegulatorRule[];
    /** Substrings of a hostname that mark a non-authoritative source. */
    readonly lowAuthorityMarkers: readonly string[];
    /** Gov-hosted CDN / object-storage buckets that are not the regulator's own page. */
    readonly govCdnExclude: readonly string[];
    /** Sent verbatim on every call so Google's implicit cache can apply. */
    readonly systemInstruction: string;
    enrichQuery(query: string, today: string): string;
    citationTargets(text: string): CitationTarget[];
}

// ---------------------------------------------------------------------------
// Singapore citation → URL builders (ported from Casey's legal_sources.py)
// ---------------------------------------------------------------------------

const SSO_HOST = "https://sso.agc.gov.sg";
const ELITIGATION_GD = "https://www.elitigation.sg/gd/s";

/**
 * Neutral-citation courts with a deterministic eLitigation slug, longest-first
 * so the alternation prefers "SGHC(I)" / "SGHC(A)" over bare "SGHC". The slug
 * drops the parentheses: SGHC(I) -> SGHCI. Superior courts first, then the
 * subordinate courts and tribunals that map 1:1 the same way.
 */
const ELIT_COURTS = [
    "SGHC(I)",
    "SGCA(I)",
    "SGHC(A)",
    "SGHCR",
    "SGHCF",
    "SGCA",
    "SGHC",
    "SGDC",
    "SGMC",
    "SGFC",
    "SGECT",
    "SGSCT",
] as const;

const COURT_ALTERNATION = ELIT_COURTS.map((court) =>
    court.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\(/g, "\\s*\\("),
).join("|");

const NEUTRAL_CITE_RE = new RegExp(
    `\\[\\s*(?<year>\\d{4})\\s*\\]\\s*(?<court>${COURT_ALTERNATION})\\s*(?<num>\\d+)`,
    "gi",
);

/**
 * Known Act short-name -> SSO slug. Only these get an exact landing URL;
 * anything else falls back to the always-valid SSO full-text search URL.
 * Keys are matched case-insensitively against the parsed Act name.
 */
export const KNOWN_ACT_SLUGS: Record<string, string> = {
    "companies act": "CoA1967",
    "insolvency, restructuring and dissolution act": "IRDA2018",
    irda: "IRDA2018",
    "evidence act": "EA1893",
    "conveyancing and law of property act": "CLPA1886",
    "civil law act": "CLA1909",
    "interpretation act": "IA1965",
    "land titles act": "LTA1993",
    "rules of court 2021": "ROC2021",
    "rules of court": "ROC2021",
    "penal code": "PC1871",
    "personal data protection act": "PDPA2012",
    "criminal procedure code": "CPC2010",
    "employment act": "EmA1968",
    "misrepresentation act": "MA1967",
    "trustees act": "TA1967",
    "contracts (rights of third parties) act": "CRTPA2001",
    "unfair contract terms act": "UCTA1977",
    "sale of goods act": "SGA1979",
    "limitation act": "LA1959",
    "frustrated contracts act": "FCA1959",
    "wills act": "WA1838",
    "probate and administration act": "PAA1934",
    "road traffic act": "RTA1961",
    "hire-purchase act": "HPA1969",
    "women's charter": "WC1961",
    "arbitration act": "AA2001",
    "international arbitration act": "IAA1994",
    "application of english law act": "AELA1993",
    "electronic transactions act": "ETA2010",
    "copyright act": "CA2021",
    "trade marks act": "TMA1998",
    "patents act": "PA1994",
    "building and construction industry security of payment act": "BCISPA2004",
    "supreme court of judicature act": "SCJA1969",
    "legal profession act": "LPA1966",
    "residential property act": "RPA1976",
};

/** Slugs that are subsidiary legislation and live under /SL/ rather than /Act/. */
const SL_SLUGS: Record<string, true> = { ROC2021: true };

const ACT_TYPE = "(?:Act|Code|Ordinance|Charter|Constitution|Rules?)";

/**
 * Two alternatives: a multi-word name that runs through lowercase connectors
 * until it ends at an Act-type keyword (so "Conveyancing and Law of Property
 * Act" survives whole), or a single capitalised token / abbreviation.
 */
const ACT_NAME =
    "(?<act>" +
    "[A-Z][\\w'&.-]*(?:[ ,]+[A-Za-z][\\w'&.-]*)*?[ ,]+" +
    ACT_TYPE +
    "|[A-Z][A-Za-z][\\w'&.-]*" +
    ")";

const STATUTE_S_RE = new RegExp(
    `\\bs\\.?\\s?(?<num>\\d+[A-Za-z]*)\\s+${ACT_NAME}\\b`,
    "g",
);

const STATUTE_SECTION_OF_RE = new RegExp(
    `\\bsection\\s+(?<num>\\d+[A-Za-z]*)\\s+of\\s+(?:the\\s+)?${ACT_NAME}\\b`,
    "g",
);

/**
 * Tried before the generic matchers: "Rules" is itself an Act-type keyword, so
 * the generic run would truncate "Rules of Court" and lose the slug.
 */
const STATUTE_ROC_RE =
    /\b(?:s\.?\s?|section\s+)(?<num>\d+[A-Za-z]*)\s+(?:of\s+the\s+)?(?<act>Rules?\s+of\s+Court(?:\s*20\d{2})?)\b/gi;

/**
 * Order/Rule citations. The trailing "Rules of Court" anchor is required so a
 * bare "O 9 r 11" in unrelated prose does not false-match.
 */
const ROC_ORDER_RULE_RE =
    /\b(?:O(?:rder)?\.?\s*(?<order>\d+))\s*,?\s*(?:r(?:ule)?\.?\s*(?<rule>\d+))(?:\s+(?:of\s+the\s+)?Rules?\s+of\s+Court(?:\s*20\d{2})?)/gi;

const ROC_2021_SLUG = "ROC2021";

function buildStatuteTarget(num: string, actName: string): CitationTarget {
    const act = actName.replace(/\s+/g, " ").trim();
    const citation = `s${num} ${act}`;
    const slug = KNOWN_ACT_SLUGS[act.toLowerCase().replace(/\.+$/, "")];
    if (slug) {
        // The landing page is always valid; SSO provision deep-links are not
        // reliable, so we stop at the instrument. Subsidiary legislation lives
        // under /SL/.
        const base = SL_SLUGS[slug] === true ? "/SL/" : "/Act/";
        return { citation, url: `${SSO_HOST}${base}${slug}` };
    }
    return {
        citation,
        url: `${SSO_HOST}/Search/Content?Phrase=${encodeURIComponent(citation)}`,
    };
}

function singaporeCitationTargets(text: string): CitationTarget[] {
    if (!text) return [];
    const targets: CitationTarget[] = [];
    const seenUrls = new Set<string>();

    for (const match of text.matchAll(NEUTRAL_CITE_RE)) {
        const groups = match.groups;
        if (!groups?.year || !groups.court || !groups.num) continue;
        const court = groups.court.replace(/\s+/g, "").toUpperCase();
        const slug = court.replace(/[()]/g, "");
        const url = `${ELITIGATION_GD}/${groups.year}_${slug}_${groups.num}`;
        if (seenUrls.has(url)) continue;
        seenUrls.add(url);
        targets.push({
            citation: `[${groups.year}] ${court} ${groups.num}`,
            url,
        });
    }

    // Spans claimed by a higher-priority statute regex are skipped by the
    // later, greedier ones.
    const consumed: [number, number][] = [];
    const seenCitations = new Set<string>();
    for (const regex of [
        STATUTE_ROC_RE,
        STATUTE_SECTION_OF_RE,
        STATUTE_S_RE,
    ]) {
        for (const match of text.matchAll(regex)) {
            const start = match.index;
            const end = start + match[0].length;
            if (consumed.some(([from, to]) => start < to && from < end)) {
                continue;
            }
            const num = match.groups?.num;
            const act = match.groups?.act?.replace(/^[\s,.]+|[\s,.]+$/g, "");
            if (!num || !act) continue;
            consumed.push([start, end]);
            const target = buildStatuteTarget(num, act);
            const key = target.citation.toLowerCase();
            if (seenCitations.has(key) || seenUrls.has(target.url)) continue;
            seenCitations.add(key);
            seenUrls.add(target.url);
            targets.push(target);
        }
    }

    for (const match of text.matchAll(ROC_ORDER_RULE_RE)) {
        const order = match.groups?.order;
        const rule = match.groups?.rule;
        if (!order || !rule) continue;
        const url = `${SSO_HOST}/SL/${ROC_2021_SLUG}`;
        const citation = `O.${order} r.${rule} Rules of Court 2021`;
        if (seenCitations.has(citation.toLowerCase())) continue;
        seenCitations.add(citation.toLowerCase());
        // The ROC landing page may already be present from a statute match;
        // the Order/Rule citation still names a distinct authority, so only an
        // identical citation is suppressed.
        if (seenUrls.has(url)) continue;
        seenUrls.add(url);
        targets.push({ citation, url });
    }

    return targets;
}

// ---------------------------------------------------------------------------
// Singapore ranking data (ported from Casey's gemini_grounding.py)
// ---------------------------------------------------------------------------

/**
 * Gov-hosted CDN / object-storage buckets that carry a *.gov.sg host but are
 * not the regulator's own authoritative page. Substring match on the hostname.
 */
const SG_GOV_CDN_EXCLUDE = [
    "isomer-user-content",
    "by.gov.sg",
    "file.go.gov.sg",
    "-user-content",
    "storage.googleapis",
] as const;

/**
 * Non-authoritative hosts — property portals, calculators, comparison sites,
 * content farms, law-firm blogs. Substring match on the hostname; only
 * consulted after the official/government checks, so "blog.gov.sg" stays
 * government.
 */
const SG_LOW_AUTHORITY_MARKERS = [
    "propertyguru",
    "99.co",
    "lovelyhomes",
    "homejourney",
    "aiproperty",
    "brandnewland",
    "newdeveloperlaunch",
    "new-condo-launch",
    "srx.com",
    "cashew.sg",
    "theloanconnection",
    "loanconnection",
    "stackedhomes",
    "mortgagemaster",
    "moneysmart",
    "seedly",
    "valuechampion",
    "dollarsandsense",
    "thesmartinvestor",
    "endowus",
    "syfe",
    "blog",
    "calculator",
    "koobiz",
    "kbatraining",
    "vjmglobal",
    "iproperty",
    "edgeprop",
    "propnex",
    "ohmyhome",
    "smartcalculator",
    "uproperty",
    "zurently",
    "newpropertylaunches",
    "newlaunches",
    "propertylaunch",
    "newlaunch",
    "sgluxurycondo",
    "condo",
    "realtor",
    "realestate",
    "redbrick.sg",
    "homely",
    "stproperty",
    "carousell",
    "mingproperty",
    "sra.org.sg",
    "karman.com.sg",
    "kbatraining.org",
    "cleartax.com",
    "lovelyhomes.com.sg",
    "toolsg.com",
    "housingloansg.com",
    "dollarbackmortgage.com",
    "tradingeconomics.com",
    "aiproperty.sg",
    "propertyguru.com.sg",
    "info-tech.com.sg",
    "propertynet.sg",
    "era.com.sg",
    "stackedhomes.com",
    "mothership.sg",
    "channelnewsasia.com",
    "straitstimes.com",
    "businesstimes.com.sg",
    "scribd.com",
    "scribd",
    "coursehero",
    "academia.edu",
    "slideshare",
    "lawhub",
    "singaporelegaladvice",
    "singaporelegal",
    "lawgazette",
    "asialawnetwork",
    "lawyered",
    "legalvision",
    "legal500",
    "chambers.com",
    "investingiguana",
    "nexusmortgage",
    "interestrates.sg",
    "finko.com.sg",
    "prezi.com",
] as const;

/**
 * Topic -> administering regulator's own domain. When the search topic matches,
 * that regulator's domain leads ahead of any other government source, so a GST
 * answer is led by IRAS rather than MOF or a blog. First match wins; order
 * matters (specific before generic).
 */
const SG_TOPIC_REGULATOR_RULES: readonly TopicRegulatorRule[] = [
    {
        pattern:
            /condition[s]?\s+of\s+sale|\blscs\b|law\s+society\s+condition|notice\s+to\s+complete/i,
        domain: "lawsociety.org.sg",
    },
    {
        pattern:
            /stamp\s*dut|\babsd\b|\bssd\b|\bbsd\b|\bgst\b|goods\s+and\s+services\s+tax|property\s+tax|income\s+tax|withholding\s+tax|tax\s+relief/i,
        domain: "iras.gov.sg",
    },
    {
        pattern: /\bsora\b|\bltv\b|loan[- ]to[- ]value|mas\s+notice|\bmas\b/i,
        domain: "mas.gov.sg",
    },
    {
        pattern:
            /\bcpf\b|\bbrs\b|ordinary\s+account|special\s+account|retirement\s+sum|wage\s+ceiling/i,
        domain: "cpf.gov.sg",
    },
    {
        pattern:
            /court\s+fee|filing\s+fee|hearing\s+fee|judgment\s+interest|interest\s+on\s+judgment|quantum|jurisdiction(al)?\s+limit/i,
        domain: "judiciary.gov.sg",
    },
    {
        pattern: /\bact\b|\bsection\b|statut|subsidiary\s+legislation/i,
        domain: "sso.agc.gov.sg",
    },
    {
        pattern: /\bacra\b|company\s+filing|incorporation\s+fee/i,
        domain: "acra.gov.sg",
    },
    {
        pattern: /\bhdb\b|housing\s+(and\s+)?development\s+board/i,
        domain: "hdb.gov.sg",
    },
    {
        pattern:
            /employment\s+pass|\bep\b|work\s+pass|salary\s+threshold|progressive\s+wage|\bmom\b/i,
        domain: "mom.gov.sg",
    },
];

/** Casey's `_SG_SYSTEM_INSTRUCTION`, verbatim. */
const SG_SYSTEM_INSTRUCTION =
    "You are a legal research assistant for a Singapore law practice. " +
    "When you search the web, you MUST go to the OFFICIAL Singapore regulator " +
    "for the topic and quote ITS OWN published figures — not third-party " +
    "property portals, tax calculators, comparison sites, or law-firm/blog " +
    "summaries. Use the authoritative source for each topic:\n" +
    "  - Taxes, GST, stamp duty (BSD/ABSD/SSD), income tax, property tax, " +
    "tax reliefs: the Inland Revenue Authority of Singapore (iras.gov.sg) — " +
    "find its own rate tables / brackets pages.\n" +
    "  - CPF contribution rates, wage ceilings, allocation: the CPF Board " +
    "(cpf.gov.sg).\n" +
    "  - Statutes, Acts, sections, subsidiary legislation: Singapore Statutes " +
    "Online (sso.agc.gov.sg).\n" +
    "  - Court rules, judgments, hearing/filing fees: the Singapore Judiciary " +
    "(judiciary.gov.sg) and eLitigation (elitigation.sg).\n" +
    "  - Employment, work passes, Progressive Wage: the Ministry of Manpower " +
    "(mom.gov.sg).\n" +
    "  - Data protection / PDPA penalties: the PDPC (pdpc.gov.sg).\n" +
    "  - Financial regulation: the Monetary Authority of Singapore (mas.gov.sg).\n" +
    "For any rate, bracket, threshold, fee, or figure used in a calculation, " +
    "retrieve the OFFICIAL regulator's own page that states it (e.g. the full " +
    "IRAS BSD/ABSD rate table) so the exact numbers are available — do not stop " +
    "at a blog that only says a figure 'is the sum of' something. " +
    "Always state the version or date of any law, rule, or figure you rely on. " +
    "CURRENCY: report the version in effect as of the date in the query, give " +
    "its effective date, and if the source is undated or the value may be " +
    "superseded, SAY SO plainly; never report a historical rate (e.g. a " +
    "prior-year SORA) as if current. " +
    "ATTRIBUTE EACH FIGURE TO ITS OWN ADMINISTERING AUTHORITY, and ONLY that " +
    "authority: a GST / stamp-duty / income-tax figure is attributed to IRAS " +
    "(iras.gov.sg); a SORA / LTV / MAS-notice figure to MAS (mas.gov.sg); a CPF " +
    "BRS / OA / wage-ceiling figure to the CPF Board (cpf.gov.sg); a court fee " +
    "or judgment-interest figure to the Judiciary (judiciary.gov.sg); a " +
    "Conditions-of-Sale point to the Law Society (lawsociety.org.sg). Do NOT " +
    "list iras.gov.sg for a MAS or CPF fact, and NEVER write a combined or " +
    "ambiguous attribution such as 'iras.gov.sg / mas.gov.sg' or 'the MAS portal " +
    "(iras.gov.sg / mas.gov.sg)' — name the single correct authority for each " +
    "individual figure. " +
    "NEVER invent, guess, or fabricate citations, URLs, case names, or " +
    "statutory provisions — only report what the search results actually support.";

const GENERAL_SYSTEM_INSTRUCTION =
    "You are a research assistant for a law practice. For the user's question, " +
    "find authoritative, recent and directly relevant sources from across the " +
    "public web and report what they say. Prefer the primary or official source " +
    "that actually sets the rule or figure over aggregators, calculators, " +
    "comparison sites, news summaries and blogs. For any rate, bracket, " +
    "threshold, fee, or figure used in a calculation, retrieve the page that " +
    "states it so the exact numbers are available. Always state the version or " +
    "date of any law, rule, or figure you rely on. CURRENCY: report the version " +
    "in effect as of the date in the query, give its effective date, and if the " +
    "source is undated or the value may be superseded, SAY SO plainly; never " +
    "report a historical value as if it were current. Attribute each figure to " +
    "the single body that administers it and never write a combined or " +
    "ambiguous attribution. NEVER invent, guess, or fabricate citations, URLs, " +
    "case names, or statutory provisions — only report what the search results " +
    "actually support.";

function generalisedSystemInstruction(
    name: string,
    domains: readonly string[],
): string {
    return (
        `You are a legal research assistant for a ${name} law practice. ` +
        `When you search the web, you MUST go to the OFFICIAL ${name} source ` +
        "for the topic and quote ITS OWN published figures — not third-party " +
        "portals, tax calculators, comparison sites, or law-firm/blog " +
        `summaries. The primary sources are ${domains.join(", ")}; for a ` +
        "regulated topic, go to the body that administers it and use its own " +
        "published tables. For any rate, bracket, threshold, fee, or figure " +
        "used in a calculation, retrieve the official page that states it so " +
        "the exact numbers are available. Always state the version or date of " +
        "any law, rule, or figure you rely on. CURRENCY: report the version in " +
        "effect as of the date in the query, give its effective date, and if " +
        "the source is undated or the value may be superseded, SAY SO plainly; " +
        "never report a historical value as if it were current. Attribute each " +
        "figure to its own administering authority and ONLY that authority; " +
        "never write a combined or ambiguous attribution. NEVER invent, guess, " +
        "or fabricate citations, URLs, case names, or statutory provisions — " +
        "only report what the search results actually support."
    );
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

const SINGAPORE: JurisdictionSources = {
    profile: "SG",
    officialDomains: [
        "sso.agc.gov.sg",
        "elitigation.sg",
        "sentencingpanel.judiciary.gov.sg",
    ],
    governmentDomains: [
        "sprs.parl.gov.sg",
        "parliament.gov.sg",
        "mlaw.gov.sg",
        "lab.mlaw.gov.sg",
        "iras.gov.sg",
        "mas.gov.sg",
        "acra.gov.sg",
        "cpf.gov.sg",
        "judiciary.gov.sg",
        "mom.gov.sg",
        "hdb.gov.sg",
        "pdpc.gov.sg",
        "lawsociety.org.sg",
        "academypublishing.org.sg",
        "journalsonline.academypublishing.org.sg",
        "sal.org.sg",
        "singaporelawwatch.sg",
        "commonlii.org",
    ],
    topicRegulatorRules: SG_TOPIC_REGULATOR_RULES,
    lowAuthorityMarkers: SG_LOW_AUTHORITY_MARKERS,
    govCdnExclude: SG_GOV_CDN_EXCLUDE,
    systemInstruction: SG_SYSTEM_INSTRUCTION,
    enrichQuery: (query, today) =>
        `${query} Jurisdiction: Singapore. Today's date is ${today}; give the figure/rate/fee/rule ` +
        "CURRENTLY IN FORCE as of that date and STATE its effective date. If recently revised, " +
        "prefer the most recently published value and note the prior one. Use official SG " +
        "government/regulator sources and their own published rate/bracket/fee tables " +
        "(iras.gov.sg taxes & stamp duty, mas.gov.sg SORA/LTV, cpf.gov.sg CPF/BRS, " +
        "acra.gov.sg company fees, sso.agc.gov.sg statutes) — not portals, calculators, or blogs.",
    citationTargets: singaporeCitationTargets,
};

function domainOnlyProfile(
    profile: JurisdictionProfile,
    name: string,
    officialDomains: readonly string[],
): JurisdictionSources {
    const systemInstruction = generalisedSystemInstruction(
        name,
        officialDomains,
    );
    const domainList = officialDomains.join(", ");
    return {
        profile,
        officialDomains,
        governmentDomains: [],
        topicRegulatorRules: [],
        lowAuthorityMarkers: [],
        govCdnExclude: [],
        systemInstruction,
        enrichQuery: (query, today) =>
            `${query} Jurisdiction: ${name}. Today is ${today}; give the rule or figure ` +
            "currently in force as of that date and state its effective date. " +
            `Prefer official sources (${domainList}).`,
        citationTargets: () => [],
    };
}

const GENERAL: JurisdictionSources = {
    profile: "general",
    officialDomains: [],
    governmentDomains: [],
    topicRegulatorRules: [],
    lowAuthorityMarkers: [],
    govCdnExclude: [],
    systemInstruction: GENERAL_SYSTEM_INSTRUCTION,
    enrichQuery: (query, today) =>
        `${query} Today is ${today}; give the rule or figure currently in force as of ` +
        "that date and state its effective date. Prefer official and primary sources.",
    citationTargets: () => [],
};

const PROFILES: Record<JurisdictionProfile, JurisdictionSources> = {
    SG: SINGAPORE,
    MY: domainOnlyProfile("MY", "Malaysian", [
        "lom.agc.gov.my",
        "kehakiman.gov.my",
    ]),
    AU: domainOnlyProfile("AU", "Australian", [
        "legislation.gov.au",
        "austlii.edu.au",
        "hcourt.gov.au",
    ]),
    GB: domainOnlyProfile("GB", "United Kingdom", [
        "legislation.gov.uk",
        "bailii.org",
        "judiciary.uk",
        "gov.uk",
    ]),
    US: domainOnlyProfile("US", "United States", [
        "law.cornell.edu",
        "courtlistener.com",
        "govinfo.gov",
        "uscourts.gov",
    ]),
    general: GENERAL,
};

/**
 * Country display names from the onboarding list that have a tuned profile.
 * Anything else — including free-text "Other" — is the general profile.
 */
const PROFILE_BY_COUNTRY: Record<string, JurisdictionProfile> = {
    singapore: "SG",
    malaysia: "MY",
    australia: "AU",
    "united kingdom": "GB",
    "united states": "US",
};

export function profileFor(
    jurisdictionName: string | null,
): JurisdictionProfile {
    if (!jurisdictionName) return "general";
    const key = jurisdictionName.trim().toLowerCase().replace(/\s+/g, " ");
    return Object.prototype.hasOwnProperty.call(PROFILE_BY_COUNTRY, key)
        ? PROFILE_BY_COUNTRY[key]
        : "general";
}

export function sourcesFor(profile: JurisdictionProfile): JurisdictionSources {
    return PROFILES[profile];
}
