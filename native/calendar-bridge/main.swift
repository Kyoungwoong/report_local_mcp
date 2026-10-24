import EventKit
import Foundation

struct BridgeRequest: Decodable {
    let action: String
    let requestPermission: Bool?
    let calendarIdentifier: String?
    let knownEventIdentifier: String?
    let localId: String?
    let workDate: String?
    let timezone: String?
    let title: String?
    let notes: String?
}

enum BridgeFailure: Error {
    case coded(String, String)
}

func emit(_ value: [String: Any]) {
    do {
        let data = try JSONSerialization.data(withJSONObject: value, options: [])
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    } catch {
        FileHandle.standardError.write(Data("calendar bridge: response encoding failed\n".utf8))
        exit(1)
    }
}

func require(_ value: String?, _ field: String) throws -> String {
    guard let value, !value.isEmpty else {
        throw BridgeFailure.coded("BRIDGE_PROTOCOL_ERROR", "Missing required field: \(field)")
    }
    return value
}

func authorizationName(_ status: EKAuthorizationStatus) -> String {
    switch status {
    case .notDetermined: return "NOT_DETERMINED"
    case .restricted: return "RESTRICTED"
    case .denied: return "DENIED"
    case .fullAccess: return "FULL_ACCESS"
    case .writeOnly: return "WRITE_ONLY"
    @unknown default: return "UNKNOWN"
    }
}

func requireFullAccess() throws {
    switch EKEventStore.authorizationStatus(for: .event) {
    case .fullAccess:
        return
    case .notDetermined:
        throw BridgeFailure.coded("PERMISSION_NOT_DETERMINED", "Calendar full access has not been requested")
    case .denied:
        throw BridgeFailure.coded("PERMISSION_DENIED", "Calendar full access was denied")
    case .restricted:
        throw BridgeFailure.coded("PERMISSION_RESTRICTED", "Calendar access is restricted")
    case .writeOnly:
        throw BridgeFailure.coded("FULL_ACCESS_REQUIRED", "Full Calendar access is required for configured-calendar lookup and duplicate recovery")
    @unknown default:
        throw BridgeFailure.coded("FULL_ACCESS_REQUIRED", "Calendar authorization status is unsupported")
    }
}

func writableCalendar(_ store: EKEventStore, identifier: String) throws -> EKCalendar {
    guard let calendar = store.calendar(withIdentifier: identifier) else {
        throw BridgeFailure.coded("CALENDAR_NOT_FOUND", "The configured Calendar no longer exists")
    }
    guard calendar.allowsContentModifications else {
        throw BridgeFailure.coded("CALENDAR_NOT_WRITABLE", "The configured Calendar is read-only")
    }
    return calendar
}

func dayRange(workDate: String, timezoneName: String) throws -> (Date, Date, TimeZone) {
    guard let timezone = TimeZone(identifier: timezoneName) else {
        throw BridgeFailure.coded("BRIDGE_PROTOCOL_ERROR", "Invalid IANA timezone")
    }
    let parts = workDate.split(separator: "-").compactMap { Int($0) }
    guard parts.count == 3 else {
        throw BridgeFailure.coded("BRIDGE_PROTOCOL_ERROR", "Invalid work date")
    }
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timezone
    var components = DateComponents()
    components.calendar = calendar
    components.timeZone = timezone
    components.year = parts[0]
    components.month = parts[1]
    components.day = parts[2]
    guard let start = calendar.date(from: components),
          let end = calendar.date(byAdding: .day, value: 1, to: start) else {
        throw BridgeFailure.coded("BRIDGE_PROTOCOL_ERROR", "Work date could not be represented")
    }
    return (start, end, timezone)
}

func marker(_ localId: String) -> String {
    "Local DevLog Calendar ID: \(localId)"
}

func localDevLogId(_ notes: String?) -> String? {
    notes?.split(separator: "\n")
        .first(where: { $0.hasPrefix("Local DevLog Calendar ID: ") })
        .map { String($0.dropFirst("Local DevLog Calendar ID: ".count)) }
}

func eventTimezone(_ notes: String?) -> String? {
    notes?.split(separator: "\n")
        .first(where: { $0.hasPrefix("시간대: ") })
        .map { String($0.dropFirst("시간대: ".count)) }
}

func calendarResult(_ calendar: EKCalendar) -> [String: Any] {
    [
        "identifier": calendar.calendarIdentifier,
        "title": calendar.title,
        "sourceTitle": calendar.source.title,
        "allowsContentModifications": calendar.allowsContentModifications,
    ]
}

@main
struct LocalDevLogCalendarBridge {
    static func main() async {
        do {
            let input = FileHandle.standardInput.readDataToEndOfFile()
            let request = try JSONDecoder().decode(BridgeRequest.self, from: input)
            let store = EKEventStore()

            switch request.action {
            case "validate":
                if request.requestPermission == true,
                   EKEventStore.authorizationStatus(for: .event) == .notDetermined {
                    _ = try await store.requestFullAccessToEvents()
                    store.reset()
                }
                let status = EKEventStore.authorizationStatus(for: .event)
                let calendars = status == .fullAccess
                    ? store.calendars(for: .event).map(calendarResult)
                    : []
                emit(["ok": true, "result": [
                    "authorizationStatus": authorizationName(status),
                    "calendars": calendars,
                ]])

            case "find":
                try requireFullAccess()
                let calendarIdentifier = try require(request.calendarIdentifier, "calendarIdentifier")
                let localId = try require(request.localId, "localId")
                let workDate = try require(request.workDate, "workDate")
                let timezoneName = try require(request.timezone, "timezone")
                let target = try writableCalendar(store, identifier: calendarIdentifier)
                let expectedMarker = marker(localId)

                if let known = request.knownEventIdentifier,
                   let event = store.event(withIdentifier: known),
                   event.notes?.contains(expectedMarker) == true {
                    let identifier = event.eventIdentifier ?? known
                    if event.calendar.calendarIdentifier == calendarIdentifier {
                        emit(["ok": true, "result": [
                            "status": "MATCH",
                            "eventIdentifier": identifier,
                            "calendarIdentifier": event.calendar.calendarIdentifier,
                        ]])
                        return
                    }
                    emit(["ok": true, "result": [
                        "status": "MOVED",
                        "eventIdentifier": identifier,
                        "calendarIdentifier": event.calendar.calendarIdentifier,
                    ]])
                    return
                }

                let (start, end, _) = try dayRange(workDate: workDate, timezoneName: timezoneName)
                let events = store.events(matching: store.predicateForEvents(
                    withStart: start,
                    end: end,
                    calendars: nil
                ))
                if let event = events.first(where: { $0.notes?.contains(expectedMarker) == true }),
                   let identifier = event.eventIdentifier {
                    let eventCalendarIdentifier = event.calendar.calendarIdentifier
                    emit(["ok": true, "result": [
                        "status": eventCalendarIdentifier == target.calendarIdentifier ? "MATCH" : "MOVED",
                        "eventIdentifier": identifier,
                        "calendarIdentifier": eventCalendarIdentifier,
                    ]])
                } else if let event = events.first(where: {
                    localDevLogId($0.notes) != nil && eventTimezone($0.notes) == timezoneName
                }), let identifier = event.eventIdentifier,
                   let existingLocalId = localDevLogId(event.notes) {
                    emit(["ok": true, "result": [
                        "status": "CONFLICT",
                        "eventIdentifier": identifier,
                        "calendarIdentifier": event.calendar.calendarIdentifier,
                        "existingLocalId": existingLocalId,
                    ]])
                } else {
                    emit(["ok": true, "result": ["status": "MISSING"]])
                }

            case "create":
                try requireFullAccess()
                let calendarIdentifier = try require(request.calendarIdentifier, "calendarIdentifier")
                let localId = try require(request.localId, "localId")
                let workDate = try require(request.workDate, "workDate")
                let timezoneName = try require(request.timezone, "timezone")
                let title = try require(request.title, "title")
                let notes = try require(request.notes, "notes")
                guard notes.contains(marker(localId)) else {
                    throw BridgeFailure.coded("BRIDGE_PROTOCOL_ERROR", "Calendar notes are missing the Local ID marker")
                }
                let calendar = try writableCalendar(store, identifier: calendarIdentifier)
                let (start, end, timezone) = try dayRange(workDate: workDate, timezoneName: timezoneName)
                let event = EKEvent(eventStore: store)
                event.calendar = calendar
                event.title = title
                event.notes = notes
                event.startDate = start
                event.endDate = end
                event.timeZone = timezone
                event.isAllDay = true
                do {
                    try store.save(event, span: .thisEvent, commit: true)
                } catch {
                    throw BridgeFailure.coded("EVENTKIT_SAVE_FAILED", "EventKit could not save the Calendar event")
                }
                guard let identifier = event.eventIdentifier else {
                    throw BridgeFailure.coded("EVENTKIT_SAVE_FAILED", "EventKit saved an event without an identifier")
                }
                emit(["ok": true, "result": ["eventIdentifier": identifier]])

            default:
                throw BridgeFailure.coded("BRIDGE_PROTOCOL_ERROR", "Unsupported bridge action")
            }
        } catch let BridgeFailure.coded(code, message) {
            emit(["ok": false, "code": code, "message": message])
        } catch {
            emit(["ok": false, "code": "EVENTKIT_READ_FAILED", "message": "Calendar operation failed"])
        }
    }
}
