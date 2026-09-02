"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

import { ProfileSearch } from "./profile-search";

type Profile = {
  name: string;
  githubLogin: string;
  searchable: boolean;
  contactSuppressions: Array<
    "professional-email" | "direct-professional-phone"
  >;
};

export function ProfileOnboarding() {
  const searchParams = useSearchParams();
  const [choice, setChoice] = useState<"choose" | "search" | "profile">(
    searchParams.get("view") === "search" ? "search" : "choose",
  );
  const [profile, setProfile] = useState<Profile | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [contactSuppressions, setContactSuppressions] = useState({
    email: false,
    phone: false,
  });

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/profile", { signal: controller.signal })
      .then((response) => response.json())
      .then((result: { profile: Profile | null }) => {
        if (result.profile !== null) {
          setProfile(result.profile);
          setContactSuppressions({
            email:
              result.profile.contactSuppressions.includes("professional-email"),
            phone: result.profile.contactSuppressions.includes(
              "direct-professional-phone",
            ),
          });
        }
        if (result.profile !== null && searchParams.get("view") !== "search") {
          setChoice("profile");
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [searchParams]);

  const submit = async (
    event: React.SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ) => {
    event.preventDefault();
    setMessage(null);
    const data = new FormData(
      event.currentTarget,
      event.nativeEvent.submitter,
    );
    const skills = String(data.get("skills") ?? "")
      .split(",")
      .map((skill) => skill.trim())
      .filter(Boolean);
    const currentCompany = String(data.get("currentCompany") ?? "").trim();
    const response = await fetch("/api/profile", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: data.get("name"),
        currentCompany: currentCompany || null,
        professionalLinks: [data.get("professionalLink")],
        statements: {
          role: String(data.get("role") ?? ""),
          location: String(data.get("location") ?? ""),
          skills,
          ...(currentCompany === "" ? {} : { currentCompany }),
          opportunityStatus: String(
            data.get("opportunityStatus") ?? "unspecified",
          ),
        },
        adultAttestation: data.get("adultAttestation") === "on",
        privateCodeAttestation: data.get("privateCodeAttestation") === "on",
        searchable: data.get("searchable") === "true",
      }),
    });
    const result = (await response.json()) as {
      profile?: Profile;
      error?: { code: string };
    };
    if (!response.ok || result.profile === undefined) {
      setMessage(profileError(result.error?.code));
      return;
    }
    setProfile(result.profile);
    setMessage(
      result.profile.searchable
        ? "Your Profile now appears in authenticated Humans searches."
        : "Your private draft is saved and does not appear in searches.",
    );
  };

  const disableSearchability = async () => {
    const response = await fetch("/api/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ searchable: false }),
    });
    const result = (await response.json()) as { profile?: Profile };
    if (response.ok && result.profile !== undefined) {
      setProfile(result.profile);
      setMessage("Your Profile was removed from searches immediately.");
    }
  };

  const toggleContactSuppression = async (type: "email" | "phone") => {
    const suppressed = !contactSuppressions[type];
    const response = await fetch(
      `/api/contact-reveals/profile/contact-suppressions/${type}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ suppressed }),
      },
    );
    if (!response.ok) {
      setMessage("Contact Reveal privacy could not be updated.");
      return;
    }
    setContactSuppressions((current) => ({ ...current, [type]: suppressed }));
    setMessage(
      `${type === "email" ? "Email" : "Phone"} Contact Reveals are now ${suppressed ? "suppressed" : "available"}.`,
    );
  };

  if (choice === "choose") {
    return (
      <section className="onboarding">
        <p className="eyebrow">Choose your path</p>
        <h1>What brings you to Humans?</h1>
        <div className="choiceGrid">
          <button
            className="choice"
            type="button"
            onClick={() => setChoice("search")}
          >
            <strong>Search Humans</strong>
            <span>
              Enter your protected workspace without becoming discoverable.
            </span>
          </button>
          <button
            className="choice accent"
            type="button"
            onClick={() => setChoice("profile")}
          >
            <strong>Appear in searches</strong>
            <span>Verify your work and explicitly publish a Profile.</span>
          </button>
        </div>
      </section>
    );
  }

  if (choice === "search") {
    return <ProfileSearch onCreateProfile={() => setChoice("profile")} />;
  }

  return (
    <section className="onboarding profileFlow">
      <p className="eyebrow">Profile onboarding</p>
      <button
        className="profileLink"
        type="button"
        onClick={() => setChoice("search")}
      >
        Search the directory
      </button>
      <h1>
        {profile === null
          ? "Show what you build."
          : `Profile for ${profile.name}`}
      </h1>
      {profile?.searchable === true && (
        <div className="published">
          Searchable as @{profile.githubLogin}
          <button type="button" onClick={disableSearchability}>
            Stop appearing in searches
          </button>
        </div>
      )}
      {profile !== null && (
        <section className="contactPrivacy">
          <div>
            <p className="eyebrow">Contact privacy</p>
            <h2>Control purchased access.</h2>
            <p>
              Suppression immediately removes existing Organization access to
              that Contact Detail type.
            </p>
          </div>
          {(["email", "phone"] as const).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => void toggleContactSuppression(type)}
            >
              {contactSuppressions[type] ? "Allow" : "Suppress"} {type} reveals
            </button>
          ))}
        </section>
      )}
      <form onSubmit={submit}>
        <label>
          Name
          <input name="name" required defaultValue={profile?.name} />
        </label>
        <label>
          Professional link
          <input
            name="professionalLink"
            type="url"
            required
            placeholder="https://github.com/you"
          />
        </label>
        <label>
          Current company <span>optional</span>
          <input name="currentCompany" />
        </label>
        <div className="split">
          <label>
            Role
            <input name="role" />
          </label>
          <label>
            Location
            <input name="location" />
          </label>
        </div>
        <label>
          Skills <span>comma separated</span>
          <input name="skills" />
        </label>
        <label>
          Opportunity status
          <select name="opportunityStatus" defaultValue="unspecified">
            <option value="unspecified">Unspecified</option>
            <option value="open">Open to opportunities</option>
            <option value="not_open">Not open</option>
          </select>
        </label>
        <p className="githubNote">
          Your connected GitHub account will be verified when you submit. Bot
          and Organization accounts are not eligible.
        </p>
        <label className="check">
          <input name="privateCodeAttestation" type="checkbox" /> I code
          primarily in private repositories and attest that I build with code.
        </label>
        <label className="check">
          <input name="adultAttestation" type="checkbox" required /> I attest
          that I am at least 18 years old.
        </label>
        <div className="formActions">
          <button type="submit" name="searchable" value="false">
            Save private draft
          </button>
          <button
            className="publish"
            type="submit"
            name="searchable"
            value="true"
          >
            Submit and appear in searches
          </button>
        </div>
        {message !== null && (
          <p role="status" className="message">
            {message}
          </p>
        )}
      </form>
    </section>
  );
}

const profileError = (code?: string) => {
  if (code === "coding_evidence_required")
    return "No recent public coding evidence was found. Use the private-code attestation if it applies.";
  if (code === "adult_required")
    return "Only adults can create searchable Profiles.";
  if (code === "ineligible_github_account_type")
    return "GitHub Bot and Organization accounts are not eligible.";
  return "Profile verification failed. Connect a personal GitHub account and try again.";
};
