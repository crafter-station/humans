# Model employers by stable identity

Humans models an employer as a Company with an internal ID, non-unique name aliases, and optional unique stable identities such as a LinkedIn organization ID or verified domain. Employment remains sourced and may conflict across providers, while `profiles.current_company` stays as a compatibility display projection; Company names are not merged automatically because unrelated employers can share a name and spelling similarity is not identity evidence.
