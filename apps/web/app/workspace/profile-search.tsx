"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

type SearchResult = {
  profileId: string;
  name: string;
  headline: string | null;
  currentResidence: string | null;
  primaryRole: string | null;
  skills: string[];
  currentCompany: string | null;
  seniority: string | null;
  experienceYears: number | null;
  opportunityStatus: "open" | "not_open" | "unspecified";
  freshness: string;
  evidence: "member" | "strong" | "supported";
};

type ProfileDetail = SearchResult & { links: string[] };
type SavedList = {
  id: string;
  name: string;
  entries: Array<{ profileId: string; profileName: string; note: string }>;
};

export function ProfileSearch({
  onCreateProfile,
}: {
  onCreateProfile: () => void;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [results, setResults] = useState<SearchResult[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [profile, setProfile] = useState<ProfileDetail | null>(null);
  const [message, setMessage] = useState("Searching protected Profiles...");
  const [lists, setLists] = useState<SavedList[]>([]);
  const [interpretationError, setInterpretationError] = useState<string | null>(
    null,
  );
  const [interpreting, setInterpreting] = useState(false);
  const searchRequestParameters = new URLSearchParams(searchParams);
  searchRequestParameters.delete("profile");
  searchRequestParameters.delete("view");
  const requestKey = searchRequestParameters.toString();
  const selectedProfileId = searchParams.get("profile");
  const refreshLists = () =>
    fetch("/api/saved-lists", { cache: "no-store" })
      .then((response) => response.json())
      .then((data: { lists: SavedList[] }) => setLists(data.lists));

  useEffect(() => {
    void refreshLists();
  }, []);

  const createList = async () => {
    const name = window.prompt("Name this shared Saved List");
    if (!name?.trim()) return;
    await fetch("/api/saved-lists", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    await refreshLists();
  };
  const toggleSaved = async (profileId: string) => {
    const list = lists[0];
    if (list === undefined) {
      await createList();
      return;
    }
    const saved = list.entries.some((entry) => entry.profileId === profileId);
    await fetch(`/api/saved-lists/${list.id}/entries/${profileId}`, {
      method: saved ? "DELETE" : "PUT",
    });
    await refreshLists();
  };

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/search?${requestKey}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Search is temporarily unavailable");
        return (await response.json()) as {
          results: SearchResult[];
          nextCursor: string | null;
        };
      })
      .then((page) => {
        setResults(page.results);
        setNextCursor(page.nextCursor);
        setMessage(
          page.results.length === 0
            ? "No Profiles match these filters."
            : `${page.results.length} Profiles on this page`,
        );
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setMessage(error instanceof Error ? error.message : "Search failed");
      });
    return () => controller.abort();
  }, [requestKey]);

  useEffect(() => {
    if (selectedProfileId === null) return;
    const controller = new AbortController();
    void fetch(`/api/search/${encodeURIComponent(selectedProfileId)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Profile is no longer available");
        return (await response.json()) as { profile: ProfileDetail };
      })
      .then(({ profile: detail }) => setProfile(detail))
      .catch(() => {
        if (!controller.signal.aborted) setProfile(null);
      });
    return () => controller.abort();
  }, [selectedProfileId]);

  const applyFilters = (form: FormData) => {
    setMessage("Searching protected Profiles...");
    const parameters = new URLSearchParams();
    parameters.set("view", "search");
    for (const name of [
      "q",
      "role",
      "skill",
      "residence",
      "company",
      "seniority",
      "experience",
      "opportunityStatus",
    ]) {
      const value = String(form.get(name) ?? "").trim();
      if (value !== "") parameters.set(name, value);
    }
    router.replace(`/workspace?${parameters}`, { scroll: false });
  };

  const interpretQuery = async (form: FormData) => {
    setInterpreting(true);
    setInterpretationError(null);
    const response = await fetch("/api/search/interpret", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: String(form.get("naturalQuery") ?? "") }),
    });
    const payload = (await response.json()) as {
      filters?: {
        query?: string;
        roles?: string[];
        skills?: string[];
        currentResidences?: string[];
        companies?: string[];
        seniorities?: string[];
        minimumExperience?: number;
        opportunityStatuses?: string[];
      };
      error?: { message: string };
    };
    setInterpreting(false);
    if (!response.ok || !payload.filters) {
      setInterpretationError(
        payload.error?.message ??
          "We could not interpret that query. Try adding a role, skill, or location.",
      );
      return;
    }
    const filters = payload.filters;
    const parameters = new URLSearchParams({
      view: "search",
      interpreted: "true",
    });
    const values: Record<string, string | undefined> = {
      q: filters.query,
      role: filters.roles?.join(","),
      skill: filters.skills?.join(","),
      residence: filters.currentResidences?.join(","),
      company: filters.companies?.join(","),
      seniority: filters.seniorities?.join(","),
      experience: filters.minimumExperience?.toString(),
      opportunityStatus: filters.opportunityStatuses?.join(","),
    };
    for (const [name, value] of Object.entries(values))
      if (value) parameters.set(name, value);
    router.replace(`/workspace?${parameters}`, { scroll: false });
  };

  const updateParameters = (
    changes: Record<string, string | null>,
    addHistoryEntry = false,
  ) => {
    const parameters = new URLSearchParams(searchParams);
    for (const [name, value] of Object.entries(changes)) {
      if (value === null) parameters.delete(name);
      else parameters.set(name, value);
    }
    const url = `/workspace?${parameters}`;
    if (addHistoryEntry) router.push(url, { scroll: false });
    else router.replace(url, { scroll: false });
  };

  return (
    <section className="searchWorkspace">
      <div className="searchHeading">
        <div>
          <p className="eyebrow">Protected directory</p>
          <h1>Find builders, not keywords.</h1>
        </div>
        <button className="profileLink" onClick={onCreateProfile}>
          Manage my Profile
        </button>
        <button className="profileLink" onClick={createList}>
          New Saved List
        </button>
      </div>

      <form action={interpretQuery} className="naturalSearch">
        <label>
          Describe who you want to find
          <input
            name="naturalQuery"
            required
            minLength={3}
            maxLength={500}
            placeholder="Senior TypeScript engineers in Colombia"
          />
        </label>
        <button disabled={interpreting}>
          {interpreting ? "Interpreting…" : "Interpret query"}
        </button>
      </form>
      {interpretationError && (
        <p className="interpretationError" role="alert">
          {interpretationError}
        </p>
      )}
      {searchParams.get("interpreted") === "true" && (
        <div className="interpretedFilters" aria-label="Inferred filters">
          <strong>Inferred filters</strong>
          {[
            "q",
            "role",
            "skill",
            "residence",
            "company",
            "seniority",
            "experience",
            "opportunityStatus",
          ].map((name) =>
            searchParams.get(name) ? (
              <span key={name}>
                {name}: {searchParams.get(name)}
              </span>
            ) : null,
          )}
          <span>Edit any field below before searching again.</span>
        </div>
      )}

      <form action={applyFilters} className="searchFilters">
        <label className="wideFilter">
          Search
          <input
            name="q"
            defaultValue={searchParams.get("q") ?? ""}
            placeholder="Name, headline, or skill"
          />
        </label>
        <label>
          Role
          <input
            name="role"
            defaultValue={searchParams.get("role") ?? ""}
            placeholder="Backend engineer"
          />
        </label>
        <label>
          Skills
          <input
            name="skill"
            defaultValue={searchParams.get("skill") ?? ""}
            placeholder="TypeScript, PostgreSQL"
          />
        </label>
        <label>
          Current residence
          <input
            name="residence"
            defaultValue={searchParams.get("residence") ?? ""}
            placeholder="Colombia"
          />
        </label>
        <label>
          Company
          <input
            name="company"
            defaultValue={searchParams.get("company") ?? ""}
            placeholder="Current company"
          />
        </label>
        <label>
          Seniority
          <select
            name="seniority"
            defaultValue={searchParams.get("seniority") ?? ""}
          >
            <option value="">Any</option>
            <option value="junior">Junior</option>
            <option value="mid">Mid-level</option>
            <option value="senior">Senior</option>
            <option value="staff">Staff+</option>
          </select>
        </label>
        <label>
          Experience
          <select
            name="experience"
            defaultValue={searchParams.get("experience") ?? ""}
          >
            <option value="">Any</option>
            <option value="3">3+ years</option>
            <option value="5">5+ years</option>
            <option value="8">8+ years</option>
            <option value="12">12+ years</option>
          </select>
        </label>
        <label>
          Opportunity status
          <select
            name="opportunityStatus"
            defaultValue={searchParams.get("opportunityStatus") ?? ""}
          >
            <option value="">Any</option>
            <option value="open">Open</option>
            <option value="not_open">Not open</option>
            <option value="unspecified">Unspecified</option>
          </select>
        </label>
        <button className="searchButton" type="submit">
          Apply filters
        </button>
      </form>

      <div className="resultsMeta">
        <span>{message}</span>
        <span>Ranked by match, evidence, and freshness</span>
      </div>
      <div className="tableFrame">
        <table className="profileTable">
          <thead>
            <tr>
              <th>Name</th>
              <th>Headline</th>
              <th>Current residence</th>
              <th>Primary role</th>
              <th>Strongest skills</th>
              <th>Company</th>
              <th>Status</th>
              <th>Freshness</th>
              <th>Saved</th>
            </tr>
          </thead>
          <tbody>
            {results.map((result) => (
              <tr
                key={result.profileId}
                onClick={() => updateParameters({ profile: result.profileId })}
              >
                <td>
                  <button className="rowName">{result.name}</button>
                </td>
                <td>{result.headline ?? "Not stated"}</td>
                <td>{result.currentResidence ?? "Not stated"}</td>
                <td>{result.primaryRole ?? "Not stated"}</td>
                <td>
                  <div className="skillList">
                    {result.skills.slice(0, 3).map((skill) => (
                      <span key={skill}>{skill}</span>
                    ))}
                  </div>
                </td>
                <td>{result.currentCompany ?? "Independent"}</td>
                <td>
                  <span className={`status status-${result.opportunityStatus}`}>
                    {statusLabel(result.opportunityStatus)}
                  </span>
                </td>
                <td>
                  <span className="freshness">
                    {relativeDate(result.freshness)} · {result.evidence}
                  </span>
                </td>
                <td>
                  <button
                    className="saveButton"
                    onClick={(event) => {
                      event.stopPropagation();
                      void toggleSaved(result.profileId);
                    }}
                  >
                    {lists.some((list) =>
                      list.entries.some(
                        (entry) => entry.profileId === result.profileId,
                      ),
                    )
                      ? "Saved"
                      : "+ Save"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pagination">
        {searchParams.has("cursor") && (
          <button onClick={() => router.back()}>Previous page</button>
        )}
        {nextCursor !== null && (
          <button
            onClick={() =>
              updateParameters({ cursor: nextCursor, profile: null }, true)
            }
          >
            Next page
          </button>
        )}
      </div>

      {selectedProfileId !== null && (
        <div
          className="panelBackdrop"
          onClick={() => updateParameters({ profile: null })}
        >
          <aside
            className="profilePanel"
            onClick={(event) => event.stopPropagation()}
            aria-label="Profile detail"
          >
            <button
              className="panelClose"
              onClick={() => updateParameters({ profile: null })}
            >
              Close
            </button>
            {profile?.profileId !== selectedProfileId ? (
              <p>Loading Profile...</p>
            ) : (
              <ProfilePanel
                profile={profile}
                lists={lists}
                onToggle={toggleSaved}
                onRefresh={refreshLists}
              />
            )}
          </aside>
        </div>
      )}
    </section>
  );
}

function ProfilePanel({
  profile,
  lists,
  onToggle,
  onRefresh,
}: {
  profile: ProfileDetail;
  lists: SavedList[];
  onToggle: (profileId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const entry = lists
    .flatMap((list) => list.entries.map((entry) => ({ ...entry, list })))
    .find((entry) => entry.profileId === profile.profileId);
  const saveNote = async (form: FormData) => {
    if (entry === undefined) return;
    await fetch(
      `/api/saved-lists/${entry.list.id}/entries/${profile.profileId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: String(form.get("note") ?? "") }),
      },
    );
    await onRefresh();
  };
  return (
    <>
      <p className="eyebrow">{profile.evidence} evidence</p>
      <h2>{profile.name}</h2>
      <p className="panelHeadline">
        {profile.headline ?? profile.primaryRole ?? "Builder"}
      </p>
      <button
        className="saveButton"
        onClick={() => void onToggle(profile.profileId)}
      >
        {entry === undefined ? "+ Save to list" : "Remove from list"}
      </button>
      {entry !== undefined && (
        <form action={saveNote} className="savedNote">
          <label>
            Team note
            <textarea
              name="note"
              defaultValue={entry.note}
              placeholder="Add context for your teammates"
            />
          </label>
          <button type="submit">Save note</button>
        </form>
      )}
      <dl>
        <div>
          <dt>Current residence</dt>
          <dd>{profile.currentResidence ?? "Not stated"}</dd>
        </div>
        <div>
          <dt>Role</dt>
          <dd>{profile.primaryRole ?? "Not stated"}</dd>
        </div>
        <div>
          <dt>Company</dt>
          <dd>{profile.currentCompany ?? "Independent"}</dd>
        </div>
        <div>
          <dt>Experience</dt>
          <dd>
            {profile.experienceYears === null
              ? "Not stated"
              : `${profile.experienceYears} years`}
          </dd>
        </div>
        <div>
          <dt>Opportunity status</dt>
          <dd>{statusLabel(profile.opportunityStatus)}</dd>
        </div>
      </dl>
      <div className="panelSkills">
        {profile.skills.map((skill) => (
          <span key={skill}>{skill}</span>
        ))}
      </div>
      {profile.links.map((link) => (
        <a
          className="professionalLink"
          href={link}
          key={link}
          target="_blank"
          rel="noreferrer"
        >
          Professional link ↗
        </a>
      ))}
    </>
  );
}

const statusLabel = (status: SearchResult["opportunityStatus"]) =>
  status === "open"
    ? "Open"
    : status === "not_open"
      ? "Not open"
      : "Unspecified";

const relativeDate = (value: string) => {
  const days = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000),
  );
  return days === 0 ? "Today" : days === 1 ? "1d ago" : `${days}d ago`;
};
