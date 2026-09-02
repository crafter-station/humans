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
  const searchRequestParameters = new URLSearchParams(searchParams);
  searchRequestParameters.delete("profile");
  searchRequestParameters.delete("view");
  const requestKey = searchRequestParameters.toString();
  const selectedProfileId = searchParams.get("profile");

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
      </div>

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
              <ProfilePanel profile={profile} />
            )}
          </aside>
        </div>
      )}
    </section>
  );
}

function ProfilePanel({ profile }: { profile: ProfileDetail }) {
  return (
    <>
      <p className="eyebrow">{profile.evidence} evidence</p>
      <h2>{profile.name}</h2>
      <p className="panelHeadline">
        {profile.headline ?? profile.primaryRole ?? "Builder"}
      </p>
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
