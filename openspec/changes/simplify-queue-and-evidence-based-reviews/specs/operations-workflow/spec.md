## Purpose

Provide a calm operational view of outstanding media with understandable reasons and useful actions, without exposing private acquisition evidence.

## ADDED Requirements

### Requirement: Queue shows outstanding work only
The Queue UI SHALL exclude fulfilled and inactive history, omit the All work switch and terminal status filters, and retain waiting-for-release items. Default rows SHALL prioritize media identity, meaningful status, relevant next time and last checked; detailed freshness and coverage diagnostics SHALL be expandable.

#### Scenario: Completed anime exists in storage
- **WHEN** fulfilled anime and waiting movies are tracked
- **THEN** Queue shows the waiting movies and not the completed anime, without an All work option

### Requirement: Review items group all underlying causes
Reviews SHALL group by movie or season before pagination and count groups rather than duplicate reason rows. Each group SHALL retain the underlying review identifiers, causes and action scopes. Resolving one cause SHALL NOT imply other causes resolved.

#### Scenario: Movie has two review reasons
- **WHEN** a movie has an availability reason and a queue reason
- **THEN** one review card includes both causes and actions reflect the whole item's remaining safety state

### Requirement: Availability and safety are not contradictory
Operations SHALL distinguish release waiting from independent review/download holds and use media-correct concise language. Unresolved safety holds SHALL not be presented as ordinary availability delays; unknown legacy causes SHALL be described honestly.

#### Scenario: Unavailable movie also has an old queue review
- **WHEN** an unavailable movie has an unresolved queue review
- **THEN** its display identifies the review as the attention state, retains the release-waiting fact, and never refers to the movie as a season

### Requirement: Contextual actions are truthful
The UI SHALL hide inapplicable recovery controls, offer Reset item with a concise confirmation, and distinguish saved-status refresh from scheduling a later retry. Rare association and reservation actions SHALL remain advanced, preserve their guarded flows and identify any prerequisite assessment as a check rather than a guaranteed executable action.

#### Scenario: Unlinked review has no releaseable reservation
- **WHEN** review details are opened for an unlinked old review
- **THEN** no dead reservation-release button appears and Reset item explains rebuilding tracking without deleting download protections

#### Scenario: Refresh saved status
- **WHEN** the operator refreshes the view
- **THEN** the UI reloads saved projections without claiming to poll Sonarr/Radarr, search or grab

### Requirement: Revised workflow remains accessible
Operations SHALL retain keyboard navigation, focus restoration, labeled confirmations, readable narrow-screen layouts and loading/error/empty feedback. No state SHALL rely on color alone.

#### Scenario: Keyboard reset on a narrow screen
- **WHEN** an operator opens and cancels the reset dialog using the keyboard
- **THEN** focus stays within the dialog while open, returns to its opener on cancellation and all content remains usable without horizontal page overflow
