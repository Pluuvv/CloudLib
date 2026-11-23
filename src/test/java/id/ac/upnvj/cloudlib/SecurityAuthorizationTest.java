package id.ac.upnvj.cloudlib;

import io.quarkus.test.junit.QuarkusTest;
import io.quarkus.test.security.SecurityAttribute;
import io.quarkus.test.security.TestSecurity;
import io.restassured.http.ContentType;
import jakarta.transaction.Transactional;
import java.time.Instant;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.equalTo;
import static org.hamcrest.Matchers.hasSize;

@QuarkusTest
class SecurityAuthorizationTest {

    private Long computerId;

    @BeforeEach
    @Transactional
    void setUp() {
        VisitorLog.deleteAll();
        ComputerReservation.deleteAll();
        Computer.deleteAll();
        Loan.deleteAll();
        BookCopy.deleteAll();
        Book.deleteAll();
        Tenant.deleteAll();

        Tenant tenant = new Tenant();
        tenant.code = "upnvj";
        tenant.name = "Perpustakaan UPNVJ";
        tenant.persist();

        Book book = new Book();
        book.tenantId = tenant.id;
        book.title = "Cloud Security";
        book.persist();

        BookCopy studentCopy = createCopy(tenant, book, "SEC-001");
        BookCopy otherCopy = createCopy(tenant, book, "SEC-002");
        createLoan(tenant, studentCopy, "member-001");
        createLoan(tenant, otherCopy, "member-002");

        Computer computer = new Computer();
        computer.tenantId = tenant.id;
        computer.label = "PC-SEC-01";
        computer.persist();
        computerId = computer.id;
    }

    @Test
    void unauthenticatedRequestIsRejected() {
        given()
        .when()
            .get("/books")
        .then()
            .statusCode(401);
    }

    @Test
    @TestSecurity(
            user = "mhs_upn",
            roles = {"mahasiswa"},
            attributes = {
                @SecurityAttribute(key = "tenant", value = "upnvj"),
                @SecurityAttribute(key = "member_ref", value = "member-001")
            })
    void studentCanReadCatalogButCannotCreateBooks() {
        given()
        .when()
            .get("/books")
        .then()
            .statusCode(200)
            .body("", hasSize(1));

        given()
            .contentType(ContentType.JSON)
            .body(Map.of("title", "Unauthorized title"))
        .when()
            .post("/books")
        .then()
            .statusCode(403);

        given()
        .when()
            .get("/dashboard/summary")
        .then()
            .statusCode(403);

        given()
        .when()
            .get("/tenants")
        .then()
            .statusCode(403);
    }

    @Test
    @TestSecurity(
            user = "admin_upn",
            roles = {"admin"},
            attributes = @SecurityAttribute(key = "tenant", value = "upnvj"))
    void adminCanCreateBooks() {
        given()
            .contentType(ContentType.JSON)
            .body(Map.of("title", "Admin-created title"))
        .when()
            .post("/books")
        .then()
            .statusCode(201)
            .body("title", equalTo("Admin-created title"));
    }

    @Test
    @TestSecurity(
            user = "mhs_upn",
            roles = {"mahasiswa"},
            attributes = @SecurityAttribute(key = "tenant", value = "upnvj"))
    void requestHeaderCannotOverrideTenantClaim() {
        given()
            .header("X-Tenant", "poltek")
        .when()
            .get("/books")
        .then()
            .statusCode(403);
    }

    @Test
    @TestSecurity(
            user = "mhs_upn",
            roles = {"mahasiswa"},
            attributes = {
                @SecurityAttribute(key = "tenant", value = "upnvj"),
                @SecurityAttribute(key = "member_ref", value = "member-001")
            })
    void studentOnlySeesTheirOwnLoans() {
        given()
        .when()
            .get("/loans/active")
        .then()
            .statusCode(200)
            .body("", hasSize(1))
            .body("[0].memberRef", equalTo("member-001"));
    }

    @Test
    @TestSecurity(
            user = "mhs_upn",
            roles = {"mahasiswa"},
            attributes = {
                @SecurityAttribute(key = "tenant", value = "upnvj"),
                @SecurityAttribute(key = "member_ref", value = "member-001")
            })
    void reservationMemberIsTakenFromTokenInsteadOfRequestBody() {
        given()
            .contentType(ContentType.JSON)
            .body(Map.of(
                    "computerId", computerId,
                    "memberRef", "member-002",
                    "slotStart", "2026-11-20T09:00:00Z"))
        .when()
            .post("/computers/reservations")
        .then()
            .statusCode(201)
            .body("memberRef", equalTo("member-001"));
    }

    @Test
    @TestSecurity(
            user = "mhs_upn",
            roles = {"mahasiswa"},
            attributes = {
                @SecurityAttribute(key = "tenant", value = "upnvj"),
                @SecurityAttribute(key = "member_ref", value = "member-001")
            })
    void studentCheckInUsesMemberClaimInsteadOfRequestBody() {
        given()
            .contentType(ContentType.JSON)
            .body(Map.of("memberRef", "member-002"))
        .when()
            .post("/attendance/checkin")
        .then()
            .statusCode(201)
            .body("memberRef", equalTo("member-001"));
    }

    @Test
    @TestSecurity(
            user = "unknown_tenant_user",
            roles = {"mahasiswa"},
            attributes = {
                @SecurityAttribute(key = "tenant", value = "unknown"),
                @SecurityAttribute(key = "member_ref", value = "member-001")
            })
    void tokenForUnprovisionedTenantIsRejected() {
        given()
        .when()
            .get("/books")
        .then()
            .statusCode(403);
    }

    private static BookCopy createCopy(Tenant tenant, Book book, String barcode) {
        BookCopy copy = new BookCopy();
        copy.tenantId = tenant.id;
        copy.bookId = book.id;
        copy.barcode = barcode;
        copy.status = "UNAVAILABLE";
        copy.persist();
        return copy;
    }

    private static void createLoan(Tenant tenant, BookCopy copy, String memberRef) {
        Loan loan = new Loan();
        loan.tenantId = tenant.id;
        loan.bookCopyId = copy.id;
        loan.memberRef = memberRef;
        loan.borrowedAt = Instant.now();
        loan.dueAt = loan.borrowedAt.plusSeconds(86400);
        loan.persist();
    }
}
