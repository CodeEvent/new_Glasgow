<?php
/**
 * The front page template.
 *
 * If a static page is assigned as the front page in Settings > Reading,
 * its content will be rendered inside the "About" split section below;
 * otherwise the section is skipped gracefully.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

get_header();
$hero_image = has_header_image() ? get_header_image() : '';
?>

<section class="hero<?php echo $hero_image ? ' hero--photo' : ''; ?>"<?php echo $hero_image ? ' style="--hero-image:url(' . esc_url( $hero_image ) . ')"' : ''; ?>>
	<div class="container">
		<span class="hero__eyebrow"><?php esc_html_e( 'Baha\'i Community of Glasgow', 'glasgow-bahai' ); ?></span>
		<h1 class="hero__title"><?php esc_html_e( 'A community building spiritual and social vitality, together.', 'glasgow-bahai' ); ?></h1>
		<p class="hero__lede"><?php esc_html_e( 'Wherever you are on your own spiritual path, you are warmly welcome to join devotional gatherings, study circles, and activities for children and junior youth taking place across Glasgow.', 'glasgow-bahai' ); ?></p>
		<div class="hero__actions">
			<a class="btn btn-solid" href="<?php echo esc_url( home_url( '/get-involved/' ) ); ?>"><?php esc_html_e( 'Get Involved', 'glasgow-bahai' ); ?></a>
			<a class="btn" href="<?php echo esc_url( home_url( '/about/' ) ); ?>"><?php esc_html_e( 'About the Faith', 'glasgow-bahai' ); ?></a>
		</div>
	</div>
</section>

<section class="quote-band">
	<div class="container">
		<blockquote>
			&ldquo;<?php esc_html_e( 'The earth is but one country, and mankind its citizens.', 'glasgow-bahai' ); ?>&rdquo;
		</blockquote>
		<cite><?php esc_html_e( 'Baha\'u\'llah', 'glasgow-bahai' ); ?></cite>
	</div>
</section>

<section class="section activities" id="activities">
	<div class="container">
		<div class="section-head">
			<span class="section-head__eyebrow"><?php esc_html_e( 'Core Activities', 'glasgow-bahai' ); ?></span>
			<h2><?php esc_html_e( 'Ways to take part in Glasgow', 'glasgow-bahai' ); ?></h2>
			<p><?php esc_html_e( 'These activities are open to people of all backgrounds and beliefs, and are offered free of charge in neighbourhoods across the city.', 'glasgow-bahai' ); ?></p>
		</div>

		<div class="activities-grid">
			<div class="activity-card">
				<svg class="activity-card__icon" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="24" cy="17" r="7"/><path d="M10 40c0-8 6-13 14-13s14 5 14 13"/></svg>
				<h3><?php esc_html_e( 'Devotional Gatherings', 'glasgow-bahai' ); ?></h3>
				<p><?php esc_html_e( 'Informal meetings in homes across Glasgow for prayer, reflection, and connection — open to people of every faith and none.', 'glasgow-bahai' ); ?></p>
				<a href="<?php echo esc_url( home_url( '/devotionals/' ) ); ?>"><?php esc_html_e( 'Learn more →', 'glasgow-bahai' ); ?></a>
			</div>
			<div class="activity-card">
				<svg class="activity-card__icon" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="8" y="10" width="32" height="26" rx="2"/><path d="M8 18h32M16 6v8M32 6v8"/></svg>
				<h3><?php esc_html_e( 'Study Circles', 'glasgow-bahai' ); ?></h3>
				<p><?php esc_html_e( 'Small groups exploring themes of spiritual and community life through a sequential course of study, open to all.', 'glasgow-bahai' ); ?></p>
				<a href="<?php echo esc_url( home_url( '/study-circles/' ) ); ?>"><?php esc_html_e( 'Learn more →', 'glasgow-bahai' ); ?></a>
			</div>
			<div class="activity-card">
				<svg class="activity-card__icon" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M24 6l4 9 10 1-7.5 7 2 10L24 28l-8.5 5 2-10L10 16l10-1z"/></svg>
				<h3><?php esc_html_e( 'Junior Youth Groups', 'glasgow-bahai' ); ?></h3>
				<p><?php esc_html_e( 'Empowering young people aged 12–15 to develop their spiritual insight and capacity to contribute to their communities.', 'glasgow-bahai' ); ?></p>
				<a href="<?php echo esc_url( home_url( '/junior-youth/' ) ); ?>"><?php esc_html_e( 'Learn more →', 'glasgow-bahai' ); ?></a>
			</div>
			<div class="activity-card">
				<svg class="activity-card__icon" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="24" cy="24" r="16"/><path d="M24 16v8l6 4"/></svg>
				<h3><?php esc_html_e( 'Children\'s Classes', 'glasgow-bahai' ); ?></h3>
				<p><?php esc_html_e( 'Classes that nurture the spiritual character of children through stories, prayers, music, and service.', 'glasgow-bahai' ); ?></p>
				<a href="<?php echo esc_url( home_url( '/childrens-classes/' ) ); ?>"><?php esc_html_e( 'Learn more →', 'glasgow-bahai' ); ?></a>
			</div>
		</div>
	</div>
</section>

<section class="section split-section">
	<div class="container split">
		<div class="split__content">
			<span class="split__eyebrow"><?php esc_html_e( 'About the Faith', 'glasgow-bahai' ); ?></span>
			<h2><?php esc_html_e( 'One God, one human family, one unfolding faith.', 'glasgow-bahai' ); ?></h2>
			<p><?php esc_html_e( 'The Baha\'i Faith teaches the oneness of God, the oneness of religion, and the oneness of humanity. Baha\'is in Glasgow — alongside friends and neighbours of every background — work together to translate these principles into everyday acts of service and community building.', 'glasgow-bahai' ); ?></p>
			<a class="btn" href="<?php echo esc_url( home_url( '/about/' ) ); ?>"><?php esc_html_e( 'Discover the Baha\'i Faith', 'glasgow-bahai' ); ?></a>
		</div>
		<div class="split__media">
			<?php glasgow_bahai_emblem( 'site-emblem' ); ?>
		</div>
	</div>
</section>

<section class="section events" id="events">
	<div class="container">
		<div class="section-head">
			<span class="section-head__eyebrow"><?php esc_html_e( 'What\'s On', 'glasgow-bahai' ); ?></span>
			<h2><?php esc_html_e( 'Upcoming gatherings', 'glasgow-bahai' ); ?></h2>
		</div>

		<div class="events-list">
			<?php
			$events_query = new WP_Query( array(
				'post_type'      => 'post',
				'posts_per_page' => 3,
				'category_name'  => 'events',
				'no_found_rows'  => true,
			) );
			if ( $events_query->have_posts() ) :
				while ( $events_query->have_posts() ) : $events_query->the_post();
					?>
					<div class="event-item">
						<div class="event-date">
							<strong><?php echo esc_html( get_the_date( 'j' ) ); ?></strong>
							<span><?php echo esc_html( get_the_date( 'M Y' ) ); ?></span>
						</div>
						<div class="event-info">
							<h3><a href="<?php the_permalink(); ?>"><?php the_title(); ?></a></h3>
							<p><?php echo esc_html( wp_trim_words( get_the_excerpt(), 20 ) ); ?></p>
						</div>
						<a class="btn" href="<?php the_permalink(); ?>"><?php esc_html_e( 'Details', 'glasgow-bahai' ); ?></a>
					</div>
					<?php
				endwhile;
				wp_reset_postdata();
			else :
				?>
				<p><?php esc_html_e( 'New dates are added regularly — check back soon, or get in touch to be added to our mailing list.', 'glasgow-bahai' ); ?></p>
				<?php
			endif;
			?>
		</div>
	</div>
</section>

<?php
$news_query = new WP_Query( array(
	'post_type'      => 'post',
	'posts_per_page' => 3,
	'category__not_in' => array_filter( array( get_cat_ID( 'events' ) ) ),
	'no_found_rows'  => true,
) );
if ( $news_query->have_posts() ) :
	?>
	<section class="section section--tight news">
		<div class="container">
			<div class="section-head">
				<span class="section-head__eyebrow"><?php esc_html_e( 'From the Community', 'glasgow-bahai' ); ?></span>
				<h2><?php esc_html_e( 'Latest news & reflections', 'glasgow-bahai' ); ?></h2>
			</div>
			<div class="news-grid">
				<?php
				while ( $news_query->have_posts() ) :
					$news_query->the_post();
					?>
					<article class="news-card">
						<?php if ( has_post_thumbnail() ) : ?>
							<a href="<?php the_permalink(); ?>" class="news-card__media">
								<?php the_post_thumbnail( 'glasgow-bahai-card', array( 'loading' => 'lazy' ) ); ?>
							</a>
						<?php endif; ?>
						<div class="news-card__body">
							<span class="news-card__date"><?php echo esc_html( get_the_date() ); ?></span>
							<h3><a href="<?php the_permalink(); ?>"><?php the_title(); ?></a></h3>
							<p><?php echo esc_html( wp_trim_words( get_the_excerpt(), 18 ) ); ?></p>
						</div>
					</article>
					<?php
				endwhile;
				wp_reset_postdata();
				?>
			</div>
		</div>
	</section>
	<?php
endif;
?>

<section class="cta-band">
	<div class="container">
		<h2><?php esc_html_e( 'Curious to learn more?', 'glasgow-bahai' ); ?></h2>
		<p><?php esc_html_e( 'We would love to welcome you to a devotional gathering, study circle, or simply have a conversation over a cup of tea.', 'glasgow-bahai' ); ?></p>
		<a class="btn btn-solid" href="<?php echo esc_url( home_url( '/contact/' ) ); ?>"><?php esc_html_e( 'Get in touch', 'glasgow-bahai' ); ?></a>
	</div>
</section>

<?php get_footer(); ?>
