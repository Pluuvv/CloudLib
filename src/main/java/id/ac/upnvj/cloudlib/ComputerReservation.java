package id.ac.upnvj.cloudlib;

import io.quarkus.hibernate.orm.panache.PanacheEntityBase;
import jakarta.persistence.*;
import java.time.Instant;

@Entity
@Table(name = "computer_reservation")
public class ComputerReservation extends PanacheEntityBase {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    public Long id;

    @Column(name = "tenant_id", nullable = false)
    public Long tenantId;

    @Column(name = "computer_id", nullable = false)
    public Long computerId;

    @Column(name = "member_ref", nullable = false)
    public String memberRef;

    @Column(name = "slot_start", nullable = false)
    public Instant slotStart;
}
