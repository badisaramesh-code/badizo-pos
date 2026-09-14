import React, { useEffect, useMemo, useState } from 'react';
import { fetchHospitalityPublic, saveHospitalityPublicBooking } from '../api/client';

function formatMoney(value) {
  return Number(value || 0).toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
}

function groupedContent(rows) {
  return rows.reduce((acc, row) => {
    acc[row.content_type] = acc[row.content_type] || [];
    acc[row.content_type].push(row);
    return acc;
  }, {});
}

const fallbackPhotos = {
  hero: '/anvi-assets/front-elevation.png',
  GALLERY: '/anvi-assets/front-elevation.png',
  ROOM: '/anvi-assets/room.jpg',
  BANQUET: '/anvi-assets/banquet.jpg',
  FOOD: '/anvi-assets/food.jpg'
};

function fallbackPhotoFor(item, variant = '') {
  if (variant === 'hero') return fallbackPhotos.hero;
  return fallbackPhotos[item.content_type] || fallbackPhotos.GALLERY;
}

function Visual({ item, className = '' }) {
  const imageUrl = item.image_url || fallbackPhotoFor(item, className.includes('anvi-hero-visual') ? 'hero' : '');
  return <img className={`anvi-card-image ${className}`} src={imageUrl} alt={item.title} />;
}

function ContentCard({ item, actionLabel = '', onAction = null, darkAction = false }) {
  return (
    <article className="anvi-card">
      <Visual item={item} />
      <div className="anvi-card-body">
        <h3>{item.title}</h3>
        <p>{item.description || 'Available at ANVI GRAND.'}</p>
        <div className="anvi-card-meta">
          {Number(item.price || 0) > 0 && <strong>{formatMoney(item.price)}{item.unit_label ? ` / ${item.unit_label}` : ''}</strong>}
          {item.capacity ? <span>{item.capacity} capacity</span> : null}
        </div>
        {actionLabel && (
          <button className={`anvi-card-action ${darkAction ? 'dark' : ''}`} type="button" onClick={() => onAction?.(item)}>
            {actionLabel}
          </button>
        )}
      </div>
    </article>
  );
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

const blankBooking = {
  customer_name: '',
  customer_phone: '',
  customer_address: '',
  booking_date: todayIso(),
  time_slot: '',
  guest_count: '',
  advance_amount: '',
  notes: ''
};

export default function AnviGrandWebsite() {
  const [data, setData] = useState({ profile: {}, content: [] });
  const [loadError, setLoadError] = useState('');
  const [cart, setCart] = useState([]);
  const [bookingTarget, setBookingTarget] = useState(null);
  const [bookingForm, setBookingForm] = useState(blankBooking);
  const [bookingMessage, setBookingMessage] = useState('');
  const [bookingError, setBookingError] = useState('');
  const [isBookingSaving, setIsBookingSaving] = useState(false);

  useEffect(() => {
    fetchHospitalityPublic()
      .then(setData)
      .catch(() => setLoadError('Website preview data is not available. Start backend and refresh.'));
  }, []);

  const groups = useMemo(() => groupedContent(data.content || []), [data.content]);
  const profile = data.profile || {};
  const heroItem = groups.GALLERY?.[0] || groups.BANQUET?.[0] || { title: 'ANVI GRAND', description: 'Hotel, restaurant and banquet experience.' };
  const cartTotal = cart.reduce((sum, item) => sum + Number(item.price || 0), 0);
  const addToCart = (item) => {
    setCart((current) => [...current, item]);
  };
  const openFoodBooking = () => {
    if (cart.length === 0) {
      setBookingError('Please add at least one food item.');
      return;
    }
    setBookingTarget({
      id: 'food-order',
      content_type: 'FOOD',
      title: `${profile.restaurant_name || 'CHIGURU'} Food Order`,
      price: cartTotal,
      unit_label: 'order'
    });
    setBookingForm({
      ...blankBooking,
      booking_date: todayIso(),
      guest_count: 1,
      notes: cart.map((item) => `1x ${item.title} - ${formatMoney(item.price)}`).join('\n')
    });
    setBookingMessage('');
    setBookingError('');
  };
  const openBooking = (item) => {
    setBookingTarget(item);
    setBookingForm({
      ...blankBooking,
      booking_date: todayIso(),
      guest_count: item.capacity ? Math.min(Number(item.capacity || 0), item.content_type === 'ROOM' ? 2 : 50) : ''
    });
    setBookingMessage('');
    setBookingError('');
  };
  const closeBooking = () => {
    if (isBookingSaving) return;
    setBookingTarget(null);
    setBookingMessage('');
    setBookingError('');
  };
  const updateBookingField = (field, value) => {
    setBookingForm((current) => ({ ...current, [field]: value }));
  };
  const submitBooking = async (event) => {
    event.preventDefault();
    if (!bookingTarget) return;
    setBookingMessage('');
    setBookingError('');
    setIsBookingSaving(true);
    try {
      const isRoom = bookingTarget.content_type === 'ROOM';
      const isFood = bookingTarget.content_type === 'FOOD';
      await saveHospitalityPublicBooking({
        booking_type: isFood ? 'FOOD' : isRoom ? 'ROOM' : 'BANQUET',
        booking_date: bookingForm.booking_date,
        time_slot: bookingForm.time_slot,
        customer_name: bookingForm.customer_name,
        customer_phone: bookingForm.customer_phone,
        customer_address: bookingForm.customer_address,
        item_title: bookingTarget.title,
        guest_count: bookingForm.guest_count,
        total_amount: bookingTarget.price || 0,
        advance_amount: bookingForm.advance_amount || 0,
        payment_mode: 'Cash',
        notes: bookingForm.notes
      });
      if (isFood) setCart([]);
      setBookingMessage(isFood ? 'Food order enquiry saved. Restaurant team will confirm.' : 'Booking enquiry saved. Reception team will confirm.');
      setBookingForm(blankBooking);
    } catch (err) {
      setBookingError(err.response?.data?.error || 'Unable to save booking. Please call reception.');
    } finally {
      setIsBookingSaving(false);
    }
  };

  return (
    <div className="anvi-site">
      <a
        className="anvi-location-float"
        href="https://maps.app.goo.gl/atP5Fkxz3FvfpumW7"
        target="_blank"
        rel="noreferrer"
        aria-label="Open ANVI GRAND location map"
        title="Open location map"
      >
        <span aria-hidden="true">⌖</span>
      </a>
      <header className="anvi-nav">
        <strong className="anvi-logo">{profile.hotel_name || 'ANVI GRAND'}</strong>
        <nav>
          <a href="#home">Home</a>
          <a href="#rooms">Rooms</a>
          <a href="#food">Dining ({profile.restaurant_name || 'CHIGURU'})</a>
          <a href="#banquet">Banquet</a>
          <a href="#gallery">Gallery</a>
          <a className="anvi-book-now" href="#contact">Book Now</a>
        </nav>
        <img className="anvi-badizo-mark" src="/badizo-logo-transparent.png" alt="Badizo" />
      </header>

      <main>
        <section id="home" className="anvi-hero">
          <Visual item={heroItem} className="anvi-hero-visual" />
          <div className="anvi-hero-copy">
            <span className="anvi-hero-kicker">Premium stay • Banquet • CHIGURU dining</span>
            <h1>
              <span>Welcome to</span>
              {profile.hotel_name || 'ANVI GRAND'}
            </h1>
            <p>Experience luxury, comfort and celebrations in Vijayawada.</p>
          </div>
        </section>

        {loadError && <div className="anvi-error">{loadError}</div>}

        <div className="anvi-site-shell">
          <div className="anvi-main-content">
            <div className="anvi-booking-row">
              <section id="rooms" className="anvi-section compact">
                <div className="anvi-section-heading">
                  <h2>Stay at {profile.hotel_name || 'ANVI GRAND'} (Rooms)</h2>
                </div>
                <div className="anvi-grid compact-grid">
                  {(groups.ROOM || []).map((item) => (
                    <ContentCard key={item.id} item={item} actionLabel="Book Room" onAction={openBooking} />
                  ))}
                </div>
              </section>

              <section id="banquet" className="anvi-section compact">
                <div className="anvi-section-heading">
                  <h2>Book Banquet Halls</h2>
                </div>
                <div className="anvi-grid compact-grid">
                  {(groups.BANQUET || []).map((item) => (
                    <ContentCard key={item.id} item={item} actionLabel={item.title?.toLowerCase().includes('mini') ? 'Book Mini Hall' : 'Reserve Banquet Hall'} onAction={openBooking} />
                  ))}
                </div>
              </section>
            </div>

            <section id="food" className="anvi-section">
              <div className="anvi-section-heading">
                <h2>Order from {profile.restaurant_name || 'CHIGURU'} Restaurant</h2>
              </div>
              <div className="anvi-grid food-grid">
                {(groups.FOOD || []).map((item) => (
                  <ContentCard key={item.id} item={item} actionLabel="Add to Order" onAction={addToCart} darkAction />
                ))}
              </div>
            </section>

            <section id="gallery" className="anvi-section">
              <div className="anvi-section-heading">
                <h2>Gallery</h2>
              </div>
              <div className="anvi-gallery">{(groups.GALLERY || []).map((item) => <Visual key={item.id} item={item} />)}</div>
            </section>
          </div>

          <aside className="anvi-cart">
            <div className="anvi-cart-box">
              <h2>{profile.restaurant_name || 'CHIGURU'} Order Cart</h2>
              <div className="anvi-cart-lines">
                {cart.length === 0 ? (
                  <p>No food items added yet.</p>
                ) : cart.map((item, index) => (
                  <div key={`${item.id}-${index}`} className="anvi-cart-line">
                    <span>1x {item.title}</span>
                    <strong>{formatMoney(item.price)}</strong>
                  </div>
                ))}
              </div>
              <div className="anvi-cart-total">
                <span>Total Payable:</span>
                <strong>{formatMoney(cartTotal)}</strong>
              </div>
              <button className="anvi-pay-button" type="button" onClick={openFoodBooking} disabled={cart.length === 0}>
                Place Food Order
              </button>
            </div>
          </aside>
        </div>

        <section id="contact" className="anvi-contact">
          <div>
            <span>Contact</span>
            <h2>{profile.hotel_name || 'ANVI GRAND'}</h2>
            <p>{profile.address || 'Near Benz Circle, Eluru Road, Vijayawada, Krishna Dist, Andhra Pradesh'}</p>
          </div>
          <a href={`tel:${profile.phone || '7569494949'}`}>{profile.phone || '7569494949'}</a>
        </section>
      </main>
      {bookingTarget && (
        <div className="anvi-booking-modal-backdrop" role="presentation">
          <div className="anvi-booking-modal" role="dialog" aria-modal="true" aria-labelledby="anvi-booking-title">
            <div className="anvi-booking-modal-head">
              <div>
                <span>{bookingTarget.content_type === 'ROOM' ? 'Room Booking' : bookingTarget.content_type === 'FOOD' ? 'Food Order' : 'Hall Booking'}</span>
                <h2 id="anvi-booking-title">{bookingTarget.title}</h2>
                <p>{formatMoney(bookingTarget.price)}{bookingTarget.unit_label ? ` / ${bookingTarget.unit_label}` : ''}</p>
              </div>
              <button type="button" onClick={closeBooking} aria-label="Close booking form">×</button>
            </div>

            {(bookingMessage || bookingError) && (
              <div className={`anvi-booking-alert ${bookingError ? 'danger' : 'success'}`}>
                {bookingError || bookingMessage}
              </div>
            )}

            <form className="anvi-booking-form" onSubmit={submitBooking}>
              <label>
                Full Name
                <input value={bookingForm.customer_name} onChange={(event) => updateBookingField('customer_name', event.target.value)} required />
              </label>
              <label>
                Phone Number
                <input value={bookingForm.customer_phone} onChange={(event) => updateBookingField('customer_phone', event.target.value)} required />
              </label>
              <label>
                Booking Date
                <input type="date" value={bookingForm.booking_date} onChange={(event) => updateBookingField('booking_date', event.target.value)} required />
              </label>
              <label>
                Time / Slot
                <input value={bookingForm.time_slot} onChange={(event) => updateBookingField('time_slot', event.target.value)} placeholder={bookingTarget.content_type === 'ROOM' ? 'Check-in time' : bookingTarget.content_type === 'FOOD' ? 'Delivery / pickup time' : 'Morning / Evening / Full day'} />
              </label>
              <label>
                Persons / Guests
                <input type="number" min="1" value={bookingForm.guest_count} onChange={(event) => updateBookingField('guest_count', event.target.value)} />
              </label>
              <label>
                Advance Amount
                <input type="number" min="0" value={bookingForm.advance_amount} onChange={(event) => updateBookingField('advance_amount', event.target.value)} />
              </label>
              <label className="wide">
                Address
                <textarea rows="2" value={bookingForm.customer_address} onChange={(event) => updateBookingField('customer_address', event.target.value)} />
              </label>
              <label className="wide">
                Notes
                <textarea rows="2" value={bookingForm.notes} onChange={(event) => updateBookingField('notes', event.target.value)} placeholder="Food, decoration, room count, event details..." />
              </label>
              <div className="anvi-booking-actions">
                <button type="button" onClick={closeBooking}>Cancel</button>
                <button type="submit" disabled={isBookingSaving}>{isBookingSaving ? 'Saving...' : 'Save Booking Enquiry'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
