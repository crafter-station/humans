# Humans

Humans is a protected directory for discovering people in Latin America who build with code, regardless of their formal job title.

## Language

**Member**:
A person who has authenticated with Humans and can use the product. A Member is not discoverable unless they choose to create or claim a Profile and make it public.
_Avoid_: User, participant

**Organization**:
A workspace whose Members share searches, saved lists, and access to Humans.
_Avoid_: Account, team, tenant

**Company**:
An employer represented independently from customer Organizations. A Company may have multiple names and stable external identities; a name alone does not establish that two Companies are the same.
_Avoid_: Organization, account, workspace

**Employment**:
A sourced relationship between a Profile and a Company, including whether the source presents it as current. Conflicting Employments may coexist and do not replace their source Observations.
_Avoid_: Organization membership, canonical employer

**Profile**:
The discoverable representation of an adult who builds with code and has a qualifying personal GitHub account. A Profile may be imported without a corresponding Member or created or claimed by a Member.
_Avoid_: Participant, contact, candidate, user

**Qualifying GitHub Account**:
A personal GitHub account with evidence of coding through an owned non-fork repository or a public contribution within the last 12 months. A controlling Member may instead verify private-account ownership and attest that they code.
_Avoid_: GitHub organization, bot account

**Imported Profile**:
An unclaimed Profile created from an approved external dataset. It is searchable by default unless suppressed.
_Avoid_: Scraped user, lead

**Public Profile**:
A Profile whose represented Member has approved its appearance in searches inside Humans. Public does not mean accessible outside authenticated Humans or indexable by external search engines.
_Avoid_: Member profile, user profile

**Opportunity Status**:
A Profile's self-reported availability for professional opportunities: open, not open, or unspecified. Humans does not infer this status.
_Avoid_: Availability score, candidate status

**Claimed Profile**:
A Profile whose represented person has authenticated and established control over it.
_Avoid_: Verified user

**Searchability**:
Whether a Profile may appear in searches inside Humans. Searchability and its reason are recorded independently from whether a Profile is imported or claimed.
_Avoid_: Public access, visibility

**Suppression Record**:
A minimal, non-searchable record retained to prevent an opted-out or removed Profile from being recreated by later imports or enrichment.
_Avoid_: Deleted profile, blocked user

**Professional Link**:
A public URL through which a person's professional work or identity can be established, such as LinkedIn, GitHub, Behance, or a personal website.
_Avoid_: Social account

**Observation**:
A sourced assertion about a Profile obtained through self-reporting, an external dataset, or an enrichment provider. Conflicting Observations may coexist without silently overwriting one another.
_Avoid_: Enriched field, truth

**Member Statement**:
An Observation explicitly supplied by the Member controlling a Profile. It takes precedence over external Observations until the Member removes it.
_Avoid_: Manual override

**Saved List**:
An Organization-owned collection of Profiles selected by its Members.
_Avoid_: Lead list, candidate list

**Credit**:
An Organization-owned unit of product usage consumed consistently by chargeable actions in the web application, API, and MCP server.
_Avoid_: Token, request allowance

**Contact Detail**:
A provider-verified professional email address or direct professional phone number associated with a Profile. Inferred and unverified contact data is excluded.
_Avoid_: Personal data, contact information

**Contact Reveal**:
An Organization-scoped purchase that gives its Members access to one Contact Detail while that detail remains valid and unsuppressed.
_Avoid_: Contact export, unlock
