"use client";

import { useAuth } from "@clerk/nextjs";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import { Card } from "@repo/ui/components/card";
import { Input } from "@repo/ui/components/input";
import { NativeSelect } from "@repo/ui/components/native-select";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@repo/ui/components/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/ui/components/table";
import { Textarea } from "@repo/ui/components/textarea";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useEffectEvent, useRef, useState } from "react";

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

type ContactDetail = {
  observationId: string;
  type: "professional-email" | "direct-professional-phone";
  maskedValue: string;
  value?: string;
  sourceCategory: string;
  collectedAt: string;
  confidence: number;
  price: 5 | 10;
  previouslyPurchased: boolean;
};
type ProfileDetail = SearchResult & {
  links: string[];
  contactDetails: ContactDetail[];
};
type SavedList = {
  id: string;
  name: string;
  entries: Array<{ profileId: string; profileName: string; note: string }>;
};
type SavedListState = "error" | "loading" | "ready";

export function ProfileSearch({
  onCreateProfile,
}: {
  onCreateProfile: () => void;
}) {
  const router = useRouter();
  const { orgRole } = useAuth();
  const searchParams = useSearchParams();
  const [results, setResults] = useState<SearchResult[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [profile, setProfile] = useState<ProfileDetail | null>(null);
  const [message, setMessage] = useState("Add a filter to search Profiles.");
  const searchRequestIds = useRef(new Map<string, string>());
  const [lists, setLists] = useState<SavedList[]>([]);
  const [listState, setListState] = useState<SavedListState>("loading");
  const [activeListId, setActiveListId] = useState<string | null>(null);
  const [listMessage, setListMessage] = useState<string | null>(null);
  const [interpretationError, setInterpretationError] = useState<string | null>(
    null,
  );
  const [interpreting, setInterpreting] = useState(false);
  const [membersCanReveal, setMembersCanReveal] = useState(true);
  const searchRequestParameters = new URLSearchParams(searchParams);
  searchRequestParameters.delete("profile");
  searchRequestParameters.delete("view");
  const requestKey = searchRequestParameters.toString();
  const selectedProfileId = searchParams.get("profile");
  const activeList =
    lists.find(({ id }) => id === activeListId) ?? lists[0] ?? null;
  const refreshLists = async (
    preferredListId?: string,
    signal?: AbortSignal,
  ) => {
    try {
      const response = await fetch("/api/saved-lists", {
        cache: "no-store",
        signal,
      });
      const data = (await response.json()) as {
        lists?: SavedList[];
        error?: { message?: string };
      };
      if (!response.ok || !Array.isArray(data.lists)) {
        throw new Error(data.error?.message ?? "Saved Lists are unavailable");
      }
      setLists(data.lists);
      setListState("ready");
      setActiveListId((current) => {
        if (
          preferredListId !== undefined &&
          data.lists?.some(({ id }) => id === preferredListId)
        ) {
          return preferredListId;
        }
        if (data.lists?.some(({ id }) => id === current)) return current;
        return data.lists?.[0]?.id ?? null;
      });
      return data.lists;
    } catch (error) {
      if (!signal?.aborted) setListState("error");
      throw error;
    }
  };
  const loadLists = useEffectEvent((signal: AbortSignal) => {
    void refreshLists(undefined, signal).catch((error: unknown) => {
      if (!signal.aborted) {
        setListState("error");
        setListMessage(
          error instanceof Error
            ? error.message
            : "Saved Lists are unavailable",
        );
      }
    });
  });

  useEffect(() => {
    const controller = new AbortController();
    loadLists(controller.signal);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (orgRole !== "org:admin") return;
    const controller = new AbortController();
    void fetch("/api/contact-reveals/organization/contact-reveal-policy", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => response.json())
      .then((result: { policy?: { membersCanReveal: boolean } }) => {
        if (result.policy) setMembersCanReveal(result.policy.membersCanReveal);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [orgRole]);

  const createList = async (profileId?: string) => {
    const name = window.prompt("Name this shared Saved List");
    if (!name?.trim()) return null;
    setListMessage(null);
    let createdListId: string | undefined;
    try {
      const response = await fetch("/api/saved-lists", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const result = (await response.json()) as {
        list?: { id: string };
        error?: { message?: string };
      };
      if (!response.ok || !result.list) {
        throw new Error(
          result.error?.message ?? "The Saved List was not created",
        );
      }
      createdListId = result.list.id;
      if (profileId !== undefined) {
        await successfulResponse(
          fetch(
            `/api/saved-lists/${encodeURIComponent(result.list.id)}/entries/${encodeURIComponent(profileId)}`,
            { method: "PUT" },
          ),
          "The Profile was not saved",
        );
      }
      await refreshLists(result.list.id);
      setListMessage(
        profileId === undefined
          ? "Saved List created."
          : "Saved List created and Profile added.",
      );
      return result.list.id;
    } catch (error) {
      if (createdListId !== undefined) {
        await refreshLists(createdListId).catch(() => undefined);
      }
      setListMessage(
        error instanceof Error
          ? error.message
          : "The Saved List was not created",
      );
      return null;
    }
  };
  const toggleSaved = async (profileId: string) => {
    if (listState !== "ready") {
      setListMessage("Wait for Saved Lists to finish loading before saving.");
      return;
    }
    const list = activeList;
    if (list === null) {
      await createList(profileId);
      return;
    }
    const saved = list.entries.some((entry) => entry.profileId === profileId);
    setListMessage(null);
    try {
      await successfulResponse(
        fetch(
          `/api/saved-lists/${encodeURIComponent(list.id)}/entries/${encodeURIComponent(profileId)}`,
          { method: saved ? "DELETE" : "PUT" },
        ),
        saved ? "The Profile was not removed" : "The Profile was not saved",
      );
      await refreshLists(list.id);
    } catch (error) {
      setListMessage(
        error instanceof Error
          ? error.message
          : "The Saved List was not updated",
      );
    }
  };
  const retryLists = () => {
    setListState("loading");
    setListMessage(null);
    void refreshLists().catch((error: unknown) => {
      setListState("error");
      setListMessage(
        error instanceof Error ? error.message : "Saved Lists are unavailable",
      );
    });
  };
  const renameActiveList = async () => {
    if (listState !== "ready" || activeList === null) return;
    const name = window.prompt(
      "Rename this shared Saved List",
      activeList.name,
    );
    if (!name?.trim() || name.trim() === activeList.name) return;
    setListMessage(null);
    try {
      await successfulResponse(
        fetch(`/api/saved-lists/${encodeURIComponent(activeList.id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        }),
        "The Saved List was not renamed",
      );
      await refreshLists(activeList.id);
      setListMessage("Saved List renamed.");
    } catch (error) {
      setListMessage(
        error instanceof Error
          ? error.message
          : "The Saved List was not renamed",
      );
    }
  };
  const deleteActiveList = async () => {
    if (
      listState !== "ready" ||
      activeList === null ||
      !window.confirm(`Delete the shared Saved List "${activeList.name}"?`)
    ) {
      return;
    }
    setListMessage(null);
    try {
      await successfulResponse(
        fetch(`/api/saved-lists/${encodeURIComponent(activeList.id)}`, {
          method: "DELETE",
        }),
        "The Saved List was not deleted",
      );
      await refreshLists();
      setListMessage("Saved List deleted.");
    } catch (error) {
      setListMessage(
        error instanceof Error
          ? error.message
          : "The Saved List was not deleted",
      );
    }
  };
  const toggleRevealPolicy = async () => {
    const next = !membersCanReveal;
    const response = await fetch(
      "/api/contact-reveals/organization/contact-reveal-policy",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ membersCanReveal: next }),
      },
    );
    if (response.ok) setMembersCanReveal(next);
  };

  useEffect(() => {
    if (requestKey === "") {
      setResults([]);
      setNextCursor(null);
      setMessage("Add a filter to search Profiles.");
      return;
    }
    const controller = new AbortController();
    const idempotencyKey =
      searchRequestIds.current.get(requestKey) ?? crypto.randomUUID();
    searchRequestIds.current.set(requestKey, idempotencyKey);
    void fetch(`/api/search?${requestKey}`, {
      signal: controller.signal,
      headers: { "Idempotency-Key": idempotencyKey },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Search is temporarily unavailable");
        return (await response.json()) as {
          results: SearchResult[];
          nextCursor: string | null;
        };
      })
      .then((page) => {
        window.dispatchEvent(new Event("humans:credits-changed"));
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
        <div className="searchActions">
          <Button
            className="profileLink"
            type="button"
            onClick={onCreateProfile}
          >
            Manage my Profile
          </Button>
          <div className="savedListControls">
            <label htmlFor="active-saved-list">
              Active Saved List
              <NativeSelect
                id="active-saved-list"
                aria-label="Active Saved List"
                value={activeList?.id ?? ""}
                onChange={(event) => setActiveListId(event.currentTarget.value)}
                disabled={listState !== "ready" || lists.length === 0}
              >
                {listState !== "ready" || lists.length === 0 ? (
                  <option value="">
                    {listState === "loading"
                      ? "Loading Saved Lists"
                      : listState === "error"
                        ? "Saved Lists unavailable"
                        : "No Saved Lists"}
                  </option>
                ) : (
                  lists.map((list) => (
                    <option value={list.id} key={list.id}>
                      {list.name}
                    </option>
                  ))
                )}
              </NativeSelect>
            </label>
            <Button
              type="button"
              disabled={listState !== "ready"}
              onClick={() => void createList()}
            >
              New
            </Button>
            {listState === "error" && (
              <Button type="button" onClick={retryLists}>
                Retry
              </Button>
            )}
            <Button
              type="button"
              disabled={listState !== "ready" || activeList === null}
              onClick={() => void renameActiveList()}
            >
              Rename
            </Button>
            <Button
              type="button"
              disabled={listState !== "ready" || activeList === null}
              onClick={() => void deleteActiveList()}
            >
              Delete
            </Button>
          </div>
          {orgRole === "org:admin" && (
            <Button
              className="profileLink"
              type="button"
              onClick={toggleRevealPolicy}
            >
              {membersCanReveal
                ? "Restrict reveals to admins"
                : "Allow all Members to reveal"}
            </Button>
          )}
        </div>
      </div>
      {listMessage && (
        <p className="savedListMessage" role="status">
          {listMessage}
        </p>
      )}
      {activeList !== null && (
        <details className="savedListDrawer">
          <summary>
            {activeList.name} · {activeList.entries.length} Profile
            {activeList.entries.length === 1 ? "" : "s"}
          </summary>
          {activeList.entries.length === 0 ? (
            <p>No Profiles saved to this list yet.</p>
          ) : (
            <ul>
              {activeList.entries.map((entry) => (
                <li key={entry.profileId}>
                  <Button
                    type="button"
                    onClick={() =>
                      updateParameters({ profile: entry.profileId }, true)
                    }
                  >
                    {entry.profileName}
                  </Button>
                  <Button
                    type="button"
                    aria-label={`Remove ${entry.profileName} from ${activeList.name}`}
                    onClick={() => void toggleSaved(entry.profileId)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </details>
      )}

      <form action={interpretQuery} className="naturalSearch">
        <label htmlFor="natural-query">
          Describe who you want to find
          <Input
            id="natural-query"
            name="naturalQuery"
            required
            minLength={3}
            maxLength={500}
            placeholder="Senior TypeScript engineers in Colombia"
          />
        </label>
        <Button type="submit" disabled={interpreting}>
          {interpreting ? "Interpreting…" : "Interpret query"}
        </Button>
      </form>
      {interpretationError && (
        <p className="interpretationError" role="alert">
          {interpretationError}
        </p>
      )}
      {searchParams.get("interpreted") === "true" && (
        <div className="interpretedFilters">
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
              <Badge key={name} variant="secondary">
                {name}: {searchParams.get(name)}
              </Badge>
            ) : null,
          )}
          <span>Edit any field below before searching again.</span>
        </div>
      )}

      <form action={applyFilters} className="searchFilters">
        <label className="wideFilter" htmlFor="profile-search-query">
          Search
          <Input
            id="profile-search-query"
            name="q"
            defaultValue={searchParams.get("q") ?? ""}
            placeholder="Name, headline, or skill"
          />
        </label>
        <label htmlFor="profile-search-role">
          Role
          <Input
            id="profile-search-role"
            name="role"
            defaultValue={searchParams.get("role") ?? ""}
            placeholder="Backend engineer"
          />
        </label>
        <label htmlFor="profile-search-skill">
          Skills
          <Input
            id="profile-search-skill"
            name="skill"
            defaultValue={searchParams.get("skill") ?? ""}
            placeholder="TypeScript, PostgreSQL"
          />
        </label>
        <label htmlFor="profile-search-residence">
          Current residence
          <Input
            id="profile-search-residence"
            name="residence"
            defaultValue={searchParams.get("residence") ?? ""}
            placeholder="Colombia"
          />
        </label>
        <label htmlFor="profile-search-company">
          Company
          <Input
            id="profile-search-company"
            name="company"
            defaultValue={searchParams.get("company") ?? ""}
            placeholder="Current company"
          />
        </label>
        <label htmlFor="profile-search-seniority">
          Seniority
          <NativeSelect
            id="profile-search-seniority"
            name="seniority"
            defaultValue={searchParams.get("seniority") ?? ""}
          >
            <option value="">Any</option>
            <option value="junior">Junior</option>
            <option value="mid">Mid-level</option>
            <option value="senior">Senior</option>
            <option value="staff">Staff+</option>
          </NativeSelect>
        </label>
        <label htmlFor="profile-search-experience">
          Experience
          <NativeSelect
            id="profile-search-experience"
            name="experience"
            defaultValue={searchParams.get("experience") ?? ""}
          >
            <option value="">Any</option>
            <option value="3">3+ years</option>
            <option value="5">5+ years</option>
            <option value="8">8+ years</option>
            <option value="12">12+ years</option>
          </NativeSelect>
        </label>
        <label htmlFor="profile-search-opportunity-status">
          Opportunity status
          <NativeSelect
            id="profile-search-opportunity-status"
            name="opportunityStatus"
            defaultValue={searchParams.get("opportunityStatus") ?? ""}
          >
            <option value="">Any</option>
            <option value="open">Open</option>
            <option value="not_open">Not open</option>
            <option value="unspecified">Unspecified</option>
          </NativeSelect>
        </label>
        <Button className="searchButton" type="submit">
          Apply filters
        </Button>
      </form>

      <div className="resultsMeta">
        <span>{message}</span>
        <span>Ranked by match, evidence, and freshness</span>
      </div>
      <div className="tableFrame">
        <Table className="profileTable">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Headline</TableHead>
              <TableHead>Current residence</TableHead>
              <TableHead>Primary role</TableHead>
              <TableHead>Strongest skills</TableHead>
              <TableHead>Company</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Freshness</TableHead>
              <TableHead>Saved</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {results.map((result) => (
              <TableRow
                key={result.profileId}
                onClick={() => updateParameters({ profile: result.profileId })}
              >
                <TableCell>
                  <Button className="rowName" type="button">
                    {result.name}
                  </Button>
                </TableCell>
                <TableCell>{result.headline ?? "Not stated"}</TableCell>
                <TableCell>{result.currentResidence ?? "Not stated"}</TableCell>
                <TableCell>{result.primaryRole ?? "Not stated"}</TableCell>
                <TableCell>
                  <div className="skillList">
                    {result.skills.slice(0, 3).map((skill) => (
                      <Badge key={skill} variant="secondary">
                        {skill}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell>{result.currentCompany ?? "Not stated"}</TableCell>
                <TableCell>
                  <Badge
                    className={`status status-${result.opportunityStatus}`}
                    variant="outline"
                  >
                    {statusLabel(result.opportunityStatus)}
                  </Badge>
                </TableCell>
                <TableCell>
                  <span className="freshness">
                    {relativeDate(result.freshness)} · {result.evidence}
                  </span>
                </TableCell>
                <TableCell>
                  <Button
                    className="saveButton"
                    type="button"
                    disabled={listState !== "ready"}
                    onClick={(event) => {
                      event.stopPropagation();
                      void toggleSaved(result.profileId);
                    }}
                  >
                    {activeList?.entries.some(
                      (entry) => entry.profileId === result.profileId,
                    )
                      ? "Saved"
                      : "+ Save"}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="pagination">
        {searchParams.has("cursor") && (
          <Button type="button" onClick={() => router.back()}>
            Previous page
          </Button>
        )}
        {nextCursor !== null && (
          <Button
            type="button"
            onClick={() =>
              updateParameters({ cursor: nextCursor, profile: null }, true)
            }
          >
            Next page
          </Button>
        )}
      </div>

      <Sheet
        open={selectedProfileId !== null}
        onOpenChange={(open) => {
          if (!open) updateParameters({ profile: null });
        }}
      >
        <SheetContent
          className="profilePanel block sm:max-w-none"
          showCloseButton={false}
        >
          <SheetTitle className="sr-only">Profile detail</SheetTitle>
          <SheetDescription className="sr-only">
            Details, skills, links, and professional Contact Details for the
            selected Profile.
          </SheetDescription>
          <SheetClose
            render={
              <Button className="panelClose" type="button" variant="ghost" />
            }
          >
            Close
          </SheetClose>
          {selectedProfileId !== null &&
            (profile?.profileId !== selectedProfileId ? (
              <p>Loading Profile...</p>
            ) : (
              <ProfilePanel
                key={profile.profileId}
                profile={profile}
                activeList={activeList}
                onToggle={toggleSaved}
                onRefresh={refreshLists}
              />
            ))}
        </SheetContent>
      </Sheet>
    </section>
  );
}

function ProfilePanel({
  profile,
  activeList,
  onToggle,
  onRefresh,
}: {
  profile: ProfileDetail;
  activeList: SavedList | null;
  onToggle: (profileId: string) => Promise<void>;
  onRefresh: () => Promise<unknown>;
}) {
  const [contactDetails, setContactDetails] = useState(profile.contactDetails);
  const [contactMessage, setContactMessage] = useState<string | null>(null);
  const [pendingContact, setPendingContact] = useState<string | null>(null);
  const entry = activeList?.entries.find(
    (entry) => entry.profileId === profile.profileId,
  );
  const saveNote = async (form: FormData) => {
    if (entry === undefined || activeList === null) return;
    try {
      await successfulResponse(
        fetch(
          `/api/saved-lists/${encodeURIComponent(activeList.id)}/entries/${encodeURIComponent(profile.profileId)}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ note: String(form.get("note") ?? "") }),
          },
        ),
        "The team note was not saved",
      );
      await onRefresh();
      setContactMessage("Team note saved.");
    } catch (error) {
      setContactMessage(
        error instanceof Error ? error.message : "The team note was not saved",
      );
    }
  };
  const reveal = async (detail: ContactDetail) => {
    setPendingContact(detail.observationId);
    setContactMessage(null);
    const type = detail.type === "professional-email" ? "email" : "phone";
    const response = await fetch(
      `/api/contact-reveals/profiles/${profile.profileId}/contact-reveals/${type}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ observationId: detail.observationId }),
      },
    );
    const result = (await response.json()) as {
      reveal?: {
        observationId: string;
        value: string;
        previouslyPurchased: boolean;
      };
      error?: { message: string };
    };
    setPendingContact(null);
    if (!response.ok || !result.reveal) {
      setContactMessage(
        result.error?.message ?? "The Contact Detail could not be revealed.",
      );
      return;
    }
    const revealed = result.reveal;
    window.dispatchEvent(new Event("humans:credits-changed"));
    setContactDetails((current) =>
      current.map((item) =>
        item.observationId === revealed.observationId
          ? {
              ...item,
              value: revealed.value,
              previouslyPurchased: true,
            }
          : item,
      ),
    );
    setContactMessage(
      result.reveal.previouslyPurchased
        ? "This Organization already owned this Contact Reveal. No Credits were charged."
        : `Contact Reveal purchased for ${detail.price} Credits.`,
    );
  };
  const reportInvalid = async (detail: ContactDetail) => {
    setPendingContact(detail.observationId);
    const response = await fetch(
      `/api/contact-reveals/contact-details/${detail.observationId}/report`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reason:
            detail.type === "professional-email"
              ? "bounced-email"
              : "wrong-phone",
        }),
      },
    );
    setPendingContact(null);
    if (!response.ok) {
      setContactMessage("The invalid Contact Detail report could not be sent.");
      return;
    }
    setContactDetails((current) =>
      current.filter(
        ({ observationId }) => observationId !== detail.observationId,
      ),
    );
    window.dispatchEvent(new Event("humans:credits-changed"));
    setContactMessage(
      "The Contact Detail was suppressed, its purchases refunded, and re-enrichment queued.",
    );
  };
  return (
    <>
      <p className="eyebrow">{profile.evidence} evidence</p>
      <h2>{profile.name}</h2>
      <p className="panelHeadline">
        {profile.headline ?? profile.primaryRole ?? "Builder"}
      </p>
      <Button
        className="saveButton"
        type="button"
        onClick={() => void onToggle(profile.profileId)}
      >
        {entry === undefined ? "+ Save to list" : "Remove from list"}
      </Button>
      {entry !== undefined && (
        <form action={saveNote} className="savedNote">
          <label htmlFor="saved-profile-note">
            Team note
            <Textarea
              id="saved-profile-note"
              name="note"
              defaultValue={entry.note}
              placeholder="Add context for your teammates"
            />
          </label>
          <Button type="submit">Save note</Button>
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
          <dd>{profile.currentCompany ?? "Not stated"}</dd>
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
          <Badge key={skill} variant="secondary">
            {skill}
          </Badge>
        ))}
      </div>
      <section className="contactDetails" aria-labelledby="contact-heading">
        <div className="contactHeading">
          <p className="eyebrow">Credit-backed access</p>
          <h3 id="contact-heading">Professional Contact Details</h3>
        </div>
        {contactDetails.length === 0 ? (
          <p className="contactEmpty">No verified professional details.</p>
        ) : (
          contactDetails.map((detail) => (
            <Card className="contactCard" key={detail.observationId}>
              <div>
                <span className="contactType">
                  {detail.type === "professional-email"
                    ? "Verified professional email"
                    : "Verified direct professional phone"}
                </span>
                <strong>{detail.value ?? detail.maskedValue}</strong>
              </div>
              <dl>
                <div>
                  <dt>Source</dt>
                  <dd>{detail.sourceCategory}</dd>
                </div>
                <div>
                  <dt>Freshness</dt>
                  <dd>{relativeDate(detail.collectedAt)}</dd>
                </div>
                <div>
                  <dt>Confidence</dt>
                  <dd>{Math.round(detail.confidence * 100)}%</dd>
                </div>
                <div>
                  <dt>Price</dt>
                  <dd>
                    {detail.previouslyPurchased
                      ? "Previously purchased · 0 Credits"
                      : `${detail.price} Credits`}
                  </dd>
                </div>
              </dl>
              {detail.value ? (
                <Button
                  className="contactReport"
                  type="button"
                  variant="destructive"
                  disabled={pendingContact === detail.observationId}
                  onClick={() => void reportInvalid(detail)}
                >
                  {detail.type === "professional-email"
                    ? "Report bounced email"
                    : "Report wrong phone"}
                </Button>
              ) : (
                <Button
                  className="contactReveal"
                  type="button"
                  disabled={pendingContact === detail.observationId}
                  onClick={() => void reveal(detail)}
                >
                  {pendingContact === detail.observationId
                    ? "Reserving Credits..."
                    : `Reveal for ${detail.price} Credits`}
                </Button>
              )}
            </Card>
          ))
        )}
        {contactMessage && (
          <p className="contactMessage" role="status">
            {contactMessage}
          </p>
        )}
      </section>
      {profile.links.map((link) => (
        <a
          aria-label={`Open ${professionalLinkLabel(link)} in a new tab`}
          className="professionalLink"
          href={link}
          key={link}
          target="_blank"
          rel="noreferrer"
        >
          {professionalLinkLabel(link)} ↗
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

const professionalLinkLabel = (value: string) => {
  const hostname = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  const labels: Record<string, string> = {
    "cal.com": "Calendar",
    "github.com": "GitHub",
    "instagram.com": "Instagram",
    "linkedin.com": "LinkedIn",
    "x.com": "X",
  };
  return labels[hostname] ?? hostname;
};

const relativeDate = (value: string) => {
  const days = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000),
  );
  return days === 0 ? "Today" : days === 1 ? "1d ago" : `${days}d ago`;
};

const successfulResponse = async (
  responsePromise: Promise<Response>,
  fallback: string,
) => {
  const response = await responsePromise;
  if (response.ok) return;
  const result = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  throw new Error(result?.error?.message ?? fallback);
};
