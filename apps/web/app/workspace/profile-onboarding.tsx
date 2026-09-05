"use client";

import { Button } from "@repo/ui/components/button";
import { Card } from "@repo/ui/components/card";
import { Checkbox } from "@repo/ui/components/checkbox";
import { Input } from "@repo/ui/components/input";
import { NativeSelect } from "@repo/ui/components/native-select";
import { Textarea } from "@repo/ui/components/textarea";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { ProfileSearch } from "./profile-search";

type Profile = {
  name: string;
  currentCompany: string | null;
  professionalLinks: string[];
  statements: Record<string, string | string[]>;
  githubLogin: string;
  searchable: boolean;
  searchabilityReason:
    | "disputed"
    | "member_opt_in"
    | "member_opt_out"
    | "operator_suppression";
  contactSuppressions: Array<
    "professional-email" | "direct-professional-phone"
  >;
};

type ClaimDiscovery = {
  candidates: Array<{
    profileId: string;
    name: string;
    githubLogin: string;
  }>;
  claim: { status: "pending_review" } | null;
};

export function ProfileOnboarding() {
  const searchParams = useSearchParams();
  const requestedView = searchParams.get("view");
  const [choice, setChoice] = useState<"choose" | "search" | "profile">(
    requestedView === "search" || requestedView === "profile"
      ? requestedView
      : "choose",
  );
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [claimDiscovery, setClaimDiscovery] = useState<ClaimDiscovery | null>(
    null,
  );
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [contactSuppressions, setContactSuppressions] = useState({
    email: false,
    phone: false,
  });

  useEffect(() => {
    if (requestedView === "search" || requestedView === "profile") {
      setChoice(requestedView);
    }
  }, [requestedView]);

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
        if (result.profile !== null && requestedView !== "search") {
          setChoice("profile");
        }
      })
      .catch(() => undefined)
      .finally(() => setProfileLoaded(true));
    return () => controller.abort();
  }, [requestedView]);

  useEffect(() => {
    if (
      choice !== "profile" ||
      !profileLoaded ||
      profile !== null ||
      claimDiscovery !== null
    ) {
      return;
    }
    const controller = new AbortController();
    void fetch("/api/profile/claim-candidates", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const result = (await response.json()) as ClaimDiscovery & {
          error?: { code: string };
        };
        if (!response.ok) throw new Error(result.error?.code);
        setClaimDiscovery(result);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setClaimDiscovery({ candidates: [], claim: null });
        setMessage(profileError(error instanceof Error ? error.message : ""));
      });
    return () => controller.abort();
  }, [choice, claimDiscovery, profile, profileLoaded]);

  const applyProfile = (nextProfile: Profile) => {
    setProfile(nextProfile);
    setContactSuppressions({
      email: nextProfile.contactSuppressions.includes("professional-email"),
      phone: nextProfile.contactSuppressions.includes(
        "direct-professional-phone",
      ),
    });
  };

  const refreshProfile = async () => {
    const response = await fetch("/api/profile", { cache: "no-store" });
    const result = (await response.json()) as { profile: Profile | null };
    if (response.ok && result.profile !== null) applyProfile(result.profile);
  };

  const requestClaim = async (profileReference: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/profile/claims", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profileReference }),
      });
      const result = (await response.json()) as {
        claim?: { status: "verified" | "pending_review" };
        error?: { code: string };
      };
      if (!response.ok || !result.claim) {
        setMessage(claimError(result.error?.code));
        return;
      }
      if (result.claim.status === "verified") {
        await refreshProfile();
        setClaimDiscovery(null);
        setMessage(
          "Your claim is verified. Review the Imported Profile before opting in.",
        );
      } else {
        setClaimDiscovery({
          candidates: [],
          claim: { status: "pending_review" },
        });
        setMessage(
          "Your claim is pending Operator review. No control was granted yet.",
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const submitManualClaim = async (
    event: React.SyntheticEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await requestClaim(String(data.get("profileReference") ?? "").trim());
  };

  const submitProfile = async (
    event: React.SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const data = new FormData(
        event.currentTarget,
        event.nativeEvent.submitter,
      );
      const skills = fieldList(data, "skills");
      const currentCompany = optionalField(data, "currentCompany");
      const professionalLinks = String(data.get("professionalLinks") ?? "")
        .split(/\r?\n/)
        .map((link) => link.trim())
        .filter(Boolean);
      const createStatements: Record<string, string | string[]> = {
        opportunityStatus: String(
          data.get("opportunityStatus") ?? "unspecified",
        ),
      };
      for (const field of ["headline", "role", "location"] as const) {
        const value = optionalField(data, field);
        if (value) createStatements[field] = value;
      }
      if (skills.length > 0) createStatements.skills = skills;
      const creating = profile === null;
      const response = await fetch(
        creating ? "/api/profile" : "/api/profile/details",
        {
          method: creating ? "PUT" : "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            creating
              ? {
                  name: data.get("name"),
                  currentCompany,
                  professionalLinks,
                  statements: createStatements,
                  adultAttestation: data.get("adultAttestation") === "on",
                  privateCodeAttestation:
                    data.get("privateCodeAttestation") === "on",
                  searchable: data.get("searchable") === "true",
                }
              : {
                  name: data.get("name"),
                  currentCompany,
                  professionalLinks,
                  statements: {
                    name: data.get("name"),
                    currentCompany,
                    headline: optionalField(data, "headline"),
                    role: optionalField(data, "role"),
                    location: optionalField(data, "location"),
                    skills: skills.length === 0 ? null : skills,
                    opportunityStatus: optionalField(data, "opportunityStatus"),
                  },
                },
          ),
        },
      );
      const result = (await response.json()) as {
        profile?: Profile;
        error?: { code: string };
      };
      if (
        !response.ok ||
        result.profile === undefined ||
        result.profile === null
      ) {
        setMessage(profileError(result.error?.code));
        return;
      }
      applyProfile(result.profile);
      setMessage(
        creating
          ? result.profile.searchable
            ? "Your Profile now appears in authenticated Humans searches."
            : "Your private Profile is saved and does not appear in searches."
          : "Your Profile and Member Statements were updated.",
      );
    } finally {
      setBusy(false);
    }
  };

  const setSearchability = async (searchable: boolean) => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ searchable }),
      });
      const result = (await response.json()) as {
        profile?: Profile;
        error?: { code: string };
      };
      if (!response.ok || !result.profile) {
        setMessage(profileError(result.error?.code));
        return;
      }
      applyProfile(result.profile);
      setMessage(
        searchable
          ? "Your Profile now appears in authenticated Humans searches."
          : "Your Profile was removed from searches immediately.",
      );
    } finally {
      setBusy(false);
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
          <Button
            className="choice"
            type="button"
            variant="outline"
            onClick={() => setChoice("search")}
          >
            <strong>Search Humans</strong>
            <span>
              Enter your protected workspace without becoming discoverable.
            </span>
          </Button>
          <Button
            className="choice"
            type="button"
            onClick={() => setChoice("profile")}
          >
            <strong>Appear in searches</strong>
            <span>Claim or create a Profile, then explicitly opt in.</span>
          </Button>
        </div>
      </section>
    );
  }

  if (choice === "search") {
    return <ProfileSearch onCreateProfile={() => setChoice("profile")} />;
  }

  const candidate = claimDiscovery?.candidates[0];
  const claimPending = claimDiscovery?.claim?.status === "pending_review";
  const claimCheckPending =
    profile === null && (!profileLoaded || claimDiscovery === null);
  const searchabilityLocked =
    profile?.searchabilityReason === "disputed" ||
    profile?.searchabilityReason === "operator_suppression";

  return (
    <section className="onboarding profileFlow">
      <p className="eyebrow">Profile control</p>
      <Button type="button" variant="link" onClick={() => setChoice("search")}>
        Search the directory
      </Button>
      <h1>
        {profile === null
          ? "Find your Profile before creating one."
          : `Profile for ${profile.name}`}
      </h1>

      {claimCheckPending && (
        <Card className="claimCard" role="status">
          Checking your verified GitHub identity for an Imported Profile match.
        </Card>
      )}

      {profile === null && claimPending && (
        <Card className="claimCard pendingClaim">
          <p className="eyebrow">Operator review</p>
          <h2>Your claim is pending.</h2>
          <p>
            The immutable GitHub account IDs did not match. The Imported Profile
            remains uncontrolled until an Operator verifies the request.
          </p>
        </Card>
      )}

      {profile === null && !claimPending && candidate && (
        <Card className="claimCard">
          <p className="eyebrow">Likely Imported Profile</p>
          <h2>{candidate.name}</h2>
          <p>
            @{candidate.githubLogin} matches your verified GitHub account. This
            suggestion does not grant control.
          </p>
          <Button
            type="button"
            disabled={busy}
            onClick={() => void requestClaim(candidate.profileId)}
          >
            Verify and claim this Profile
          </Button>
        </Card>
      )}

      {profile === null &&
        !claimCheckPending &&
        !claimPending &&
        candidate === undefined && (
          <form className="referenceClaim" onSubmit={submitManualClaim}>
            <div>
              <p className="eyebrow">Already listed?</p>
              <h2>Request control with a Profile reference.</h2>
              <p>
                A mismatch goes to Operator review and never grants control
                automatically.
              </p>
            </div>
            <label htmlFor="profileReference">
              Profile reference
              <Input
                id="profileReference"
                name="profileReference"
                required
                autoComplete="off"
              />
            </label>
            <Button type="submit" disabled={busy}>
              Request claim
            </Button>
          </form>
        )}

      {profile !== null && (
        <div className={profile.searchable ? "published" : "privateProfile"}>
          <span>
            {profile.searchable
              ? `Searchable as @${profile.githubLogin}`
              : searchabilityLocked
                ? "Searchability is locked during review."
                : "This Profile is not appearing in searches."}
          </span>
          {!searchabilityLocked && (
            <Button
              type="button"
              variant={profile.searchable ? "destructive" : "default"}
              disabled={busy}
              onClick={() => void setSearchability(!profile.searchable)}
            >
              {profile.searchable
                ? "Stop appearing in searches"
                : "Appear in searches"}
            </Button>
          )}
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
            <Button
              key={type}
              type="button"
              variant={contactSuppressions[type] ? "outline" : "destructive"}
              onClick={() => void toggleContactSuppression(type)}
            >
              {contactSuppressions[type] ? "Allow" : "Suppress"} {type} reveals
            </Button>
          ))}
        </section>
      )}

      {(profile !== null ||
        (!claimCheckPending && !claimPending && candidate === undefined)) && (
        <form onSubmit={submitProfile}>
          <label htmlFor="name">
            Name
            <Input
              id="name"
              name="name"
              required
              defaultValue={profile?.name}
            />
          </label>
          <label htmlFor="professionalLinks">
            Professional links <span>one URL per line</span>
            <Textarea
              id="professionalLinks"
              name="professionalLinks"
              required
              rows={3}
              defaultValue={profile?.professionalLinks.join("\n")}
              placeholder="https://github.com/you"
            />
          </label>
          <label htmlFor="currentCompany">
            Current company <span>optional Member Statement</span>
            <Input
              id="currentCompany"
              name="currentCompany"
              defaultValue={profile?.currentCompany ?? ""}
            />
          </label>
          <label htmlFor="headline">
            Headline <span>optional Member Statement</span>
            <Input
              id="headline"
              name="headline"
              defaultValue={statement(profile, "headline")}
            />
          </label>
          <div className="split">
            <label htmlFor="role">
              Role <span>optional Member Statement</span>
              <Input
                id="role"
                name="role"
                defaultValue={statement(profile, "role")}
              />
            </label>
            <label htmlFor="location">
              Location <span>optional Member Statement</span>
              <Input
                id="location"
                name="location"
                defaultValue={statement(profile, "location")}
              />
            </label>
          </div>
          <label htmlFor="skills">
            Skills <span>comma separated Member Statement</span>
            <Input
              id="skills"
              name="skills"
              defaultValue={statementList(profile, "skills")}
            />
          </label>
          <label htmlFor="opportunityStatus">
            Opportunity status <span>Member Statement</span>
            <NativeSelect
              id="opportunityStatus"
              name="opportunityStatus"
              defaultValue={
                profile
                  ? statement(profile, "opportunityStatus")
                  : "unspecified"
              }
            >
              {profile && <option value="">Use sourced value</option>}
              <option value="unspecified">Unspecified</option>
              <option value="open">Open to opportunities</option>
              <option value="not_open">Not open</option>
            </NativeSelect>
          </label>
          <p className="githubNote">
            GitHub and LinkedIn identity changes are accepted only when the
            matching provider identity is verified through Clerk. Other edits
            apply immediately. Clear a Member Statement to restore sourced
            Observations.
          </p>
          {profile === null && (
            <>
              <label className="check" htmlFor="privateCodeAttestation">
                <Checkbox
                  id="privateCodeAttestation"
                  name="privateCodeAttestation"
                />{" "}
                I code primarily in private repositories and attest that I build
                with code.
              </label>
              <label className="check" htmlFor="adultAttestation">
                <Checkbox
                  id="adultAttestation"
                  name="adultAttestation"
                  required
                />{" "}
                I attest that I am at least 18 years old.
              </label>
            </>
          )}
          <div className="formActions">
            {profile === null ? (
              <>
                <Button
                  type="submit"
                  variant="outline"
                  name="searchable"
                  value="false"
                  disabled={busy}
                >
                  Save private Profile
                </Button>
                <Button
                  type="submit"
                  name="searchable"
                  value="true"
                  disabled={busy}
                >
                  Create and appear in searches
                </Button>
              </>
            ) : (
              <Button type="submit" disabled={busy}>
                Save Profile changes
              </Button>
            )}
          </div>
        </form>
      )}

      {message !== null && (
        <p role="status" className="message">
          {message}
        </p>
      )}
    </section>
  );
}

const optionalField = (data: FormData, name: string) =>
  String(data.get(name) ?? "").trim() || null;

const fieldList = (data: FormData, name: string) =>
  String(data.get(name) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

const statement = (profile: Profile | null, field: string) => {
  const value = profile?.statements[field];
  return typeof value === "string" ? value : "";
};

const statementList = (profile: Profile | null, field: string) => {
  const value = profile?.statements[field];
  return Array.isArray(value) ? value.join(", ") : "";
};

const claimError = (code?: string) =>
  code === "invalid_profile_claim"
    ? "Enter the opaque Profile reference exactly as shown in Humans."
    : "That claim could not be completed. The reference may be unavailable.";

const profileError = (code?: string) => {
  if (code === "coding_evidence_required")
    return "No recent public coding evidence was found. Use the private-code attestation if it applies.";
  if (code === "adult_required")
    return "Only adults can create or claim Profiles.";
  if (code === "ineligible_github_account_type")
    return "GitHub Bot and Organization accounts are not eligible.";
  if (code === "github_ownership_not_verified")
    return "Connect and verify your personal GitHub account before continuing.";
  if (code === "imported_profile_claim_required")
    return "An Imported Profile already uses this GitHub identity. Claim it instead of creating a duplicate.";
  if (code === "profile_claim_pending")
    return "Your claim must complete Operator review before you create a Profile.";
  if (
    code === "canonical_identity_change_requires_verification" ||
    code === "canonical_identity_mismatch"
  )
    return "Connect the matching GitHub or LinkedIn identity before changing that canonical link.";
  if (code === "profile_searchability_locked")
    return "Searchability is locked while this Profile is disputed or suppressed.";
  return "Profile verification failed. Check the fields and try again.";
};
